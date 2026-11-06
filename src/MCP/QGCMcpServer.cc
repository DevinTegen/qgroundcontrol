#include "QGCMcpServer.h"

#include <algorithm>
#include <cmath>

#include <QtCore/QApplicationStatic>
#include <QtCore/QCoreApplication>
#include <QtCore/QJsonDocument>
#include <QtCore/QSettings>
#include <QtHttpServer/QHttpServer>
#include <QtHttpServer/QHttpServerRequest>
#include <QtHttpServer/QHttpServerResponse>
#include <QtNetwork/QHttpHeaders>
#include <QtNetwork/QTcpServer>

#include "AppMessages.h"
#include "CompInfoParam.h"
#include "ComponentInformationManager.h"
#include "Fact.h"
#include "FactGroup.h"
#include "FirmwarePlugin.h"
#include "MultiVehicleManager.h"
#include "ParameterManager.h"
#include "QGCLoggingCategory.h"
#include "QGCMcpProposal.h"
#include "Vehicle.h"

QGC_LOGGING_CATEGORY(QGCMcpServerLog, "MCP.QGCMcpServer")

Q_APPLICATION_STATIC(QGCMcpServer, _qgcMcpServer);

namespace {

constexpr const char *kSettingsGroup = "MCP";
constexpr const char *kEnabledKey = "enabled";
constexpr const char *kDefaultProtocolVersion = "2025-06-18";
constexpr int kDefaultSearchLimit = 50;
constexpr int kMaxSearchLimit = 300;
constexpr int kMaxProposalChanges = 40;

const QString kServerInstructions = QStringLiteral(
    "You are connected to QGroundControl, a ground station talking to a live drone or plane. "
    "Workflow: call get_vehicle_status first; it reports the firmware, its exact version and which parameter "
    "documentation is loaded. Parameter names differ between firmware versions, so only use names returned by "
    "search_parameters / get_parameters for this vehicle, never names remembered from other versions. Read a "
    "parameter's description, range and options with get_parameters before proposing a value. Propose small, "
    "explained changes with propose_parameter_changes. Nothing is written until the user clicks Apply in "
    "QGroundControl; poll get_proposal_status to learn the outcome. Changes are refused while the vehicle is armed. "
    "Prefer conservative steps for tuning parameters and mention when a reboot is required.");

QString _mcpValueToString(const QJsonValue &value)
{
    if (value.isDouble()) {
        return QString::number(value.toDouble(), 'g', 12);
    }
    if (value.isBool()) {
        return value.toBool() ? QStringLiteral("1") : QStringLiteral("0");
    }
    return value.toString().trimmed();
}

QJsonObject _mcpTextResult(const QJsonObject &payload, bool isError)
{
    const QString text = QString::fromUtf8(QJsonDocument(payload).toJson(QJsonDocument::Indented));
    return QJsonObject{
        {QStringLiteral("content"), QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                                           {QStringLiteral("text"), text}}}},
        {QStringLiteral("isError"), isError},
    };
}

QJsonObject _mcpRpcError(const QJsonValue &id, int code, const QString &message)
{
    return QJsonObject{
        {QStringLiteral("jsonrpc"), QStringLiteral("2.0")},
        {QStringLiteral("id"), id},
        {QStringLiteral("error"), QJsonObject{{QStringLiteral("code"), code}, {QStringLiteral("message"), message}}},
    };
}

QJsonObject _mcpSchema(const QJsonObject &properties, const QJsonArray &required = {})
{
    QJsonObject schema{{QStringLiteral("type"), QStringLiteral("object")}, {QStringLiteral("properties"), properties}};
    if (!required.isEmpty()) {
        schema.insert(QStringLiteral("required"), required);
    }
    return schema;
}

QJsonObject _mcpTool(const QString &name, const QString &description, const QJsonObject &schema, bool readOnly)
{
    return QJsonObject{
        {QStringLiteral("name"), name},
        {QStringLiteral("description"), description},
        {QStringLiteral("inputSchema"), schema},
        {QStringLiteral("annotations"), QJsonObject{{QStringLiteral("readOnlyHint"), readOnly}}},
    };
}

QJsonObject _mcpFactGroupValues(const FactGroup *group)
{
    QJsonObject values;
    for (const QString &name : group->factNames()) {
        Fact *fact = group->getFact(name);
        if (!fact) {
            continue;
        }
        const QString units = fact->cookedUnits();
        values.insert(name, units.isEmpty() ? fact->cookedValueString() : fact->cookedValueString() + u' ' + units);
    }
    return values;
}

} // namespace

QGCMcpServer::QGCMcpServer(QObject *parent)
    : QObject(parent)
{
    QSettings settings;
    settings.beginGroup(kSettingsGroup);
    _enabled = settings.value(kEnabledKey, true).toBool();
}

QGCMcpServer::~QGCMcpServer()
{
    _stop();
}

QGCMcpServer *QGCMcpServer::instance()
{
    return _qgcMcpServer();
}

void QGCMcpServer::init()
{
    (void) connect(MultiVehicleManager::instance(), &MultiVehicleManager::activeVehicleChanged, this,
                   &QGCMcpServer::_activeVehicleChanged);
    _activeVehicleChanged(MultiVehicleManager::instance()->activeVehicle());

    // Unit tests run many app instances; never bind a fixed port there.
    if (_enabled && !QGC::runningUnitTests()) {
        _start();
    }
}

bool QGCMcpServer::running() const
{
    return _tcpServer && _tcpServer->isListening();
}

void QGCMcpServer::setEnabled(bool enabled)
{
    if (_enabled == enabled) {
        return;
    }
    _enabled = enabled;
    QSettings settings;
    settings.beginGroup(kSettingsGroup);
    settings.setValue(kEnabledKey, enabled);
    if (enabled) {
        _start();
    } else {
        _stop();
    }
    emit enabledChanged();
}

QString QGCMcpServer::endpointUrl() const
{
    return QStringLiteral("http://127.0.0.1:%1/mcp").arg(_port);
}

QString QGCMcpServer::bridgeCommand() const
{
    return QCoreApplication::applicationFilePath();
}

QString QGCMcpServer::desktopConfig() const
{
    const QJsonObject config{
        {QStringLiteral("mcpServers"), QJsonObject{
            {QStringLiteral("qgroundcontrol"), QJsonObject{
                {QStringLiteral("command"), bridgeCommand()},
                {QStringLiteral("args"), QJsonArray{QStringLiteral("--mcp-bridge")}},
            }},
        }},
    };
    return QString::fromUtf8(QJsonDocument(config).toJson(QJsonDocument::Indented));
}

void QGCMcpServer::_start()
{
    if (running()) {
        return;
    }

    _errorString.clear();
    _tcpServer = new QTcpServer(this);
    if (!_tcpServer->listen(QHostAddress::LocalHost, _port)) {
        _errorString = tr("Could not listen on port %1: %2").arg(_port).arg(_tcpServer->errorString());
        qCWarning(QGCMcpServerLog) << _errorString;
        _tcpServer->deleteLater();
        _tcpServer = nullptr;
        emit runningChanged();
        return;
    }

    _httpServer = new QHttpServer(this);
    _httpServer->route(QStringLiteral("/mcp"), QHttpServerRequest::Method::Post, [this](const QHttpServerRequest &request) {
        // Browsers send Origin; reject cross-site pages trying to reach the local server (DNS rebinding).
        const QByteArrayView origin = request.headers().value(QHttpHeaders::WellKnownHeader::Origin);
        if (!origin.isEmpty() && !origin.startsWith("http://127.0.0.1") && !origin.startsWith("http://localhost")) {
            return QHttpServerResponse(QHttpServerResponder::StatusCode::Forbidden);
        }

        bool noContent = false;
        const QByteArray body = _handleHttpBody(request.body(), noContent);
        if (noContent) {
            return QHttpServerResponse(QHttpServerResponder::StatusCode::Accepted);
        }
        return QHttpServerResponse(QByteArrayLiteral("application/json"), body);
    });
    _httpServer->route(QStringLiteral("/mcp"), QHttpServerRequest::Method::Get, [](const QHttpServerRequest &) {
        return QHttpServerResponse(QHttpServerResponder::StatusCode::MethodNotAllowed);
    });

    if (!_httpServer->bind(_tcpServer)) {
        _errorString = tr("Could not start the HTTP server");
        qCWarning(QGCMcpServerLog) << _errorString;
        _stop();
        return;
    }

    qCDebug(QGCMcpServerLog) << "MCP server listening on" << endpointUrl();
    emit runningChanged();
}

void QGCMcpServer::_stop()
{
    if (_httpServer) {
        _httpServer->deleteLater();
        _httpServer = nullptr;
    }
    if (_tcpServer) {
        _tcpServer->close();
        _tcpServer->deleteLater();
        _tcpServer = nullptr;
    }
    emit runningChanged();
}

QByteArray QGCMcpServer::_handleHttpBody(const QByteArray &body, bool &noContent)
{
    noContent = false;
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(body, &parseError);
    if (parseError.error != QJsonParseError::NoError) {
        return QJsonDocument(_mcpRpcError(QJsonValue::Null, -32700, parseError.errorString())).toJson(QJsonDocument::Compact);
    }

    if (doc.isArray()) {
        QJsonArray responses;
        for (const QJsonValue &value : doc.array()) {
            const QJsonObject response = handleJsonRpc(value.toObject());
            if (!response.isEmpty()) {
                responses.append(response);
            }
        }
        noContent = responses.isEmpty();
        return QJsonDocument(responses).toJson(QJsonDocument::Compact);
    }

    const QJsonObject response = handleJsonRpc(doc.object());
    noContent = response.isEmpty();
    return QJsonDocument(response).toJson(QJsonDocument::Compact);
}

QJsonObject QGCMcpServer::handleJsonRpc(const QJsonObject &message)
{
    const QString method = message.value(u"method").toString();
    const bool isRequest = message.contains(u"id");
    const QJsonValue id = message.value(u"id");

    if (!isRequest) {
        // Notifications (initialized, cancelled, ...) and client responses need no reply.
        return QJsonObject();
    }

    _clientRequests++;
    emit clientRequestsChanged();

    QJsonObject result;
    if (method == u"initialize") {
        const QJsonObject params = message.value(u"params").toObject();
        const QString requested = params.value(u"protocolVersion").toString();
        result = QJsonObject{
            {QStringLiteral("protocolVersion"), requested.isEmpty() ? QString::fromLatin1(kDefaultProtocolVersion) : requested},
            {QStringLiteral("capabilities"), QJsonObject{{QStringLiteral("tools"), QJsonObject{{QStringLiteral("listChanged"), false}}}}},
            {QStringLiteral("serverInfo"), QJsonObject{{QStringLiteral("name"), QStringLiteral("qgroundcontrol")},
                                                       {QStringLiteral("version"), QCoreApplication::applicationVersion()}}},
            {QStringLiteral("instructions"), kServerInstructions},
        };
    } else if (method == u"ping") {
        result = QJsonObject();
    } else if (method == u"tools/list") {
        result = QJsonObject{{QStringLiteral("tools"), _toolDefinitions()}};
    } else if (method == u"tools/call") {
        const QJsonObject params = message.value(u"params").toObject();
        bool isError = false;
        const QJsonObject payload = _callTool(params.value(u"name").toString(), params.value(u"arguments").toObject(), isError);
        result = _mcpTextResult(payload, isError);
    } else {
        return _mcpRpcError(id, -32601, QStringLiteral("Method not found: %1").arg(method));
    }

    return QJsonObject{{QStringLiteral("jsonrpc"), QStringLiteral("2.0")}, {QStringLiteral("id"), id}, {QStringLiteral("result"), result}};
}

QJsonArray QGCMcpServer::_toolDefinitions() const
{
    const QJsonObject stringProp{{QStringLiteral("type"), QStringLiteral("string")}};

    return QJsonArray{
        _mcpTool(QStringLiteral("get_vehicle_status"),
                 QStringLiteral("Connected vehicle: firmware type and exact version, vehicle type, armed state, flight "
                                "mode, which parameter documentation is loaded, and current telemetry."),
                 _mcpSchema({}), true),
        _mcpTool(QStringLiteral("search_parameters"),
                 QStringLiteral("Search the vehicle's parameters by name or description (space separated terms, all must "
                                "match). Returns name, value, units, default and a short description."),
                 _mcpSchema({{QStringLiteral("query"), QJsonObject{{QStringLiteral("type"), QStringLiteral("string")},
                                                                    {QStringLiteral("description"), QStringLiteral("e.g. \"roll rate\" or \"PTCH2SRV\"")}}},
                             {QStringLiteral("modified_only"), QJsonObject{{QStringLiteral("type"), QStringLiteral("boolean")}}},
                             {QStringLiteral("limit"), QJsonObject{{QStringLiteral("type"), QStringLiteral("integer")}}}}),
                 true),
        _mcpTool(QStringLiteral("get_parameters"),
                 QStringLiteral("Full documentation and current value for specific parameters: long description, units, "
                                "range, increment, enum options, bitmask bits, default, reboot-required and read-only flags."),
                 _mcpSchema({{QStringLiteral("names"), QJsonObject{{QStringLiteral("type"), QStringLiteral("array")},
                                                                    {QStringLiteral("items"), stringProp}}}},
                            QJsonArray{QStringLiteral("names")}),
                 true),
        _mcpTool(QStringLiteral("list_modified_parameters"),
                 QStringLiteral("All parameters whose value differs from the firmware default."),
                 _mcpSchema({}), true),
        _mcpTool(QStringLiteral("propose_parameter_changes"),
                 QStringLiteral("Propose parameter changes. They are shown to the user in QGroundControl and only written "
                                "if the user approves. Values are in the units shown by get_parameters; enum parameters "
                                "accept the numeric value or the option label; bitmasks take the combined integer."),
                 _mcpSchema({{QStringLiteral("summary"), QJsonObject{{QStringLiteral("type"), QStringLiteral("string")},
                                                                      {QStringLiteral("description"), QStringLiteral("What the changes do overall, shown to the user")}}},
                             {QStringLiteral("changes"), QJsonObject{
                                 {QStringLiteral("type"), QStringLiteral("array")},
                                 {QStringLiteral("items"), _mcpSchema({{QStringLiteral("name"), stringProp},
                                                                       {QStringLiteral("value"), QJsonObject{{QStringLiteral("type"), QJsonArray{QStringLiteral("number"), QStringLiteral("string"), QStringLiteral("boolean")}}}},
                                                                       {QStringLiteral("reason"), stringProp}},
                                                                      QJsonArray{QStringLiteral("name"), QStringLiteral("value")})}}}},
                            QJsonArray{QStringLiteral("summary"), QStringLiteral("changes")}),
                 false),
        _mcpTool(QStringLiteral("get_proposal_status"),
                 QStringLiteral("Whether the user applied or rejected a proposal, and the per-parameter outcome."),
                 _mcpSchema({{QStringLiteral("proposal_id"), QJsonObject{{QStringLiteral("type"), QStringLiteral("integer")}}}},
                            QJsonArray{QStringLiteral("proposal_id")}),
                 true),
        _mcpTool(QStringLiteral("get_rc_channels"),
                 QStringLiteral("Latest RC input PWM per channel and what each channel is mapped to (RCMAP_*, flight mode "
                                "channel, RCn_OPTION)."),
                 _mcpSchema({}), true),
    };
}

QJsonObject QGCMcpServer::_callTool(const QString &name, const QJsonObject &args, bool &isError)
{
    isError = false;
    qCDebug(QGCMcpServerLog) << "tool call:" << name;

    if (name == u"get_vehicle_status") {
        return _toolVehicleStatus();
    } else if (name == u"search_parameters") {
        return _toolSearchParameters(args, isError);
    } else if (name == u"get_parameters") {
        return _toolGetParameters(args, isError);
    } else if (name == u"list_modified_parameters") {
        return _toolListModified(isError);
    } else if (name == u"propose_parameter_changes") {
        return _toolProposeChanges(args, isError);
    } else if (name == u"get_proposal_status") {
        return _toolProposalStatus(args, isError);
    } else if (name == u"get_rc_channels") {
        return _toolRcChannels(isError);
    }

    isError = true;
    return _error(QStringLiteral("Unknown tool: %1").arg(name));
}

QJsonObject QGCMcpServer::_error(const QString &message)
{
    return QJsonObject{{QStringLiteral("error"), message}};
}

Vehicle *QGCMcpServer::_vehicleWithParams(bool &isError, QJsonObject &errorResult) const
{
    Vehicle *vehicle = MultiVehicleManager::instance()->activeVehicle();
    if (!vehicle) {
        isError = true;
        errorResult = _error(QStringLiteral("No vehicle is connected to QGroundControl."));
        return nullptr;
    }
    if (!vehicle->parameterManager()->parametersReady()) {
        isError = true;
        errorResult = _error(QStringLiteral("Parameters are still downloading from the vehicle. Try again shortly."));
        return nullptr;
    }
    return vehicle;
}

QJsonObject QGCMcpServer::_factSummary(Fact *fact)
{
    QJsonObject obj{
        {QStringLiteral("name"), fact->name()},
        {QStringLiteral("value"), fact->cookedValueString()},
    };
    if (!fact->enumStrings().isEmpty() && fact->bitmaskStrings().isEmpty()) {
        obj.insert(QStringLiteral("value_label"), fact->enumStringValue());
    }
    if (!fact->cookedUnits().isEmpty()) {
        obj.insert(QStringLiteral("units"), fact->cookedUnits());
    }
    if (fact->defaultValueAvailable()) {
        obj.insert(QStringLiteral("default"), fact->cookedDefaultValueString());
        obj.insert(QStringLiteral("modified"), !fact->valueEqualsDefault());
    }
    if (!fact->shortDescription().isEmpty()) {
        obj.insert(QStringLiteral("description"), fact->shortDescription());
    } else if (fact->longDescription().isEmpty()) {
        obj.insert(QStringLiteral("undocumented"), true);
    }
    return obj;
}

QJsonObject QGCMcpServer::_factDetail(Fact *fact)
{
    QJsonObject obj = _factSummary(fact);
    if (!fact->longDescription().isEmpty()) {
        obj.insert(QStringLiteral("long_description"), fact->longDescription());
    }
    obj.insert(QStringLiteral("group"), fact->group());
    if (!fact->minIsDefaultForType()) {
        obj.insert(QStringLiteral("min"), fact->cookedMinString());
    }
    if (!fact->maxIsDefaultForType()) {
        obj.insert(QStringLiteral("max"), fact->cookedMaxString());
    }
    const double increment = fact->rawIncrement();
    if (increment > 0 && !std::isnan(increment)) {
        obj.insert(QStringLiteral("increment"), increment);
    }

    const QStringList bitmaskStrings = fact->bitmaskStrings();
    const QStringList enumStrings = fact->enumStrings();
    if (!bitmaskStrings.isEmpty()) {
        QJsonArray bits;
        const QVariantList bitmaskValues = fact->bitmaskValues();
        for (qsizetype i = 0; i < bitmaskStrings.size(); i++) {
            bits.append(QJsonObject{{QStringLiteral("mask"), bitmaskValues.value(i).toString()},
                                    {QStringLiteral("label"), bitmaskStrings[i]}});
        }
        obj.insert(QStringLiteral("bitmask"), bits);
        obj.insert(QStringLiteral("selected_bits"), QJsonArray::fromStringList(fact->selectedBitmaskStrings()));
    } else if (!enumStrings.isEmpty()) {
        QJsonArray options;
        const QVariantList enumValues = fact->enumValues();
        for (qsizetype i = 0; i < enumStrings.size(); i++) {
            options.append(QJsonObject{{QStringLiteral("value"), enumValues.value(i).toString()},
                                       {QStringLiteral("label"), enumStrings[i]}});
        }
        obj.insert(QStringLiteral("options"), options);
    }
    if (fact->vehicleRebootRequired()) {
        obj.insert(QStringLiteral("reboot_required"), true);
    }
    if (fact->readOnly()) {
        obj.insert(QStringLiteral("read_only"), true);
    }
    return obj;
}

QJsonObject QGCMcpServer::_toolVehicleStatus()
{
    Vehicle *vehicle = MultiVehicleManager::instance()->activeVehicle();
    if (!vehicle) {
        return QJsonObject{{QStringLiteral("connected"), false},
                           {QStringLiteral("message"), QStringLiteral("No vehicle is connected to QGroundControl.")}};
    }

    ParameterManager *paramMgr = vehicle->parameterManager();
    QString docs;
    ComponentInformationManager *compInfoMgr = vehicle->compInfoManager();
    if (CompInfoParam *compInfoParam = compInfoMgr ? compInfoMgr->compInfoParam(MAV_COMP_ID_AUTOPILOT1) : nullptr) {
        const QString file = compInfoParam->firmwareMetaDataFile();
        docs = file.isEmpty() ? QStringLiteral("Supplied by the vehicle") : vehicle->firmwarePlugin()->parameterMetaDataDescription(file);
    }

    bool defaultsAvailable = false;
    for (const QString &name : paramMgr->parameterNames(ParameterManager::defaultComponentId)) {
        if (paramMgr->getParameter(ParameterManager::defaultComponentId, name)->defaultValueAvailable()) {
            defaultsAvailable = true;
            break;
        }
    }

    QJsonObject telemetry = _mcpFactGroupValues(vehicle);
    for (auto it = vehicle->factGroups().constBegin(); it != vehicle->factGroups().constEnd(); ++it) {
        if (it.value() && it.value()->telemetryAvailable()) {
            telemetry.insert(it.key(), _mcpFactGroupValues(it.value()));
        }
    }

    return QJsonObject{
        {QStringLiteral("connected"), true},
        {QStringLiteral("firmware"), vehicle->firmwareTypeString()},
        {QStringLiteral("vehicle_type"), vehicle->vehicleTypeString()},
        {QStringLiteral("firmware_version"), QStringLiteral("%1.%2.%3 %4")
                                                 .arg(vehicle->firmwareMajorVersion())
                                                 .arg(vehicle->firmwareMinorVersion())
                                                 .arg(vehicle->firmwarePatchVersion())
                                                 .arg(vehicle->firmwareVersionTypeString())},
        {QStringLiteral("armed"), vehicle->armed()},
        {QStringLiteral("flight_mode"), vehicle->flightMode()},
        {QStringLiteral("parameters_ready"), paramMgr->parametersReady()},
        {QStringLiteral("parameter_count"), static_cast<int>(paramMgr->parameterNames(ParameterManager::defaultComponentId).size())},
        {QStringLiteral("parameter_docs"), docs},
        {QStringLiteral("defaults_available"), defaultsAvailable},
        {QStringLiteral("telemetry"), telemetry},
    };
}

QJsonObject QGCMcpServer::_toolSearchParameters(const QJsonObject &args, bool &isError)
{
    QJsonObject errorResult;
    Vehicle *vehicle = _vehicleWithParams(isError, errorResult);
    if (!vehicle) {
        return errorResult;
    }

    const QStringList terms = args.value(u"query").toString().split(u' ', Qt::SkipEmptyParts);
    const bool modifiedOnly = args.value(u"modified_only").toBool(false);
    const int limit = std::clamp(args.value(u"limit").toInt(kDefaultSearchLimit), 1, kMaxSearchLimit);

    ParameterManager *paramMgr = vehicle->parameterManager();
    QJsonArray matches;
    int total = 0;
    for (const QString &name : paramMgr->parameterNames(ParameterManager::defaultComponentId)) {
        Fact *fact = paramMgr->getParameter(ParameterManager::defaultComponentId, name);
        if (modifiedOnly && (!fact->defaultValueAvailable() || fact->valueEqualsDefault())) {
            continue;
        }
        bool matched = true;
        for (const QString &term : terms) {
            if (!name.contains(term, Qt::CaseInsensitive) && !fact->shortDescription().contains(term, Qt::CaseInsensitive) &&
                !fact->longDescription().contains(term, Qt::CaseInsensitive)) {
                matched = false;
                break;
            }
        }
        if (!matched) {
            continue;
        }
        total++;
        if (matches.size() < limit) {
            matches.append(_factSummary(fact));
        }
    }

    return QJsonObject{
        {QStringLiteral("total_matches"), total},
        {QStringLiteral("returned"), matches.size()},
        {QStringLiteral("parameters"), matches},
    };
}

QJsonObject QGCMcpServer::_toolGetParameters(const QJsonObject &args, bool &isError)
{
    QJsonObject errorResult;
    Vehicle *vehicle = _vehicleWithParams(isError, errorResult);
    if (!vehicle) {
        return errorResult;
    }

    ParameterManager *paramMgr = vehicle->parameterManager();
    const QStringList allNames = paramMgr->parameterNames(ParameterManager::defaultComponentId);
    QJsonArray found;
    QJsonArray missing;
    for (const QJsonValue &value : args.value(u"names").toArray()) {
        const QString name = value.toString().trimmed().toUpper();
        if (paramMgr->parameterExists(ParameterManager::defaultComponentId, name)) {
            found.append(_factDetail(paramMgr->getParameter(ParameterManager::defaultComponentId, name)));
            continue;
        }
        // Names change between firmware versions; offer this vehicle's closest names.
        const QString prefix = name.section(u'_', 0, 0);
        QJsonArray similar;
        for (const QString &candidate : allNames) {
            if (similar.size() >= 8) {
                break;
            }
            if (candidate.startsWith(prefix + u'_') || candidate.contains(name.section(u'_', -1))) {
                similar.append(candidate);
            }
        }
        missing.append(QJsonObject{{QStringLiteral("name"), name},
                                   {QStringLiteral("error"), QStringLiteral("Not a parameter on this vehicle/firmware")},
                                   {QStringLiteral("similar"), similar}});
    }

    QJsonObject result{{QStringLiteral("parameters"), found}};
    if (!missing.isEmpty()) {
        result.insert(QStringLiteral("not_found"), missing);
    }
    return result;
}

QJsonObject QGCMcpServer::_toolListModified(bool &isError)
{
    QJsonObject args{{QStringLiteral("modified_only"), true}, {QStringLiteral("limit"), kMaxSearchLimit}};
    QJsonObject result = _toolSearchParameters(args, isError);
    if (!isError && result.value(u"total_matches").toInt() == 0) {
        Vehicle *vehicle = MultiVehicleManager::instance()->activeVehicle();
        bool defaultsAvailable = false;
        if (vehicle) {
            ParameterManager *paramMgr = vehicle->parameterManager();
            for (const QString &name : paramMgr->parameterNames(ParameterManager::defaultComponentId)) {
                if (paramMgr->getParameter(ParameterManager::defaultComponentId, name)->defaultValueAvailable()) {
                    defaultsAvailable = true;
                    break;
                }
            }
        }
        if (!defaultsAvailable) {
            result.insert(QStringLiteral("note"), QStringLiteral("The vehicle did not report default values, so modified "
                                                                 "parameters cannot be determined."));
        }
    }
    return result;
}

QJsonObject QGCMcpServer::_toolProposeChanges(const QJsonObject &args, bool &isError)
{
    QJsonObject errorResult;
    Vehicle *vehicle = _vehicleWithParams(isError, errorResult);
    if (!vehicle) {
        return errorResult;
    }

    const QJsonArray requested = args.value(u"changes").toArray();
    if (requested.isEmpty()) {
        isError = true;
        return _error(QStringLiteral("No changes given."));
    }
    if (requested.size() > kMaxProposalChanges) {
        isError = true;
        return _error(QStringLiteral("Too many changes in one proposal (max %1). Split them up.").arg(kMaxProposalChanges));
    }

    ParameterManager *paramMgr = vehicle->parameterManager();
    QList<QGCMcpProposal::Change> changes;
    for (const QJsonValue &value : requested) {
        const QJsonObject item = value.toObject();
        QGCMcpProposal::Change change;
        change.name = item.value(u"name").toString().trimmed().toUpper();
        change.reason = item.value(u"reason").toString();
        change.proposedValue = _mcpValueToString(item.value(u"value"));

        if (!paramMgr->parameterExists(ParameterManager::defaultComponentId, change.name)) {
            change.error = QStringLiteral("Not a parameter on this vehicle/firmware");
            changes.append(change);
            continue;
        }

        Fact *fact = paramMgr->getParameter(ParameterManager::defaultComponentId, change.name);
        change.units = fact->cookedUnits();
        change.description = fact->shortDescription();
        change.rebootRequired = fact->vehicleRebootRequired();
        change.currentValue = fact->cookedValueString();
        if (!fact->enumStrings().isEmpty() && fact->bitmaskStrings().isEmpty()) {
            change.currentValue += QStringLiteral(" (%1)").arg(fact->enumStringValue());
            const QStringList enumStrings = fact->enumStrings();
            const QVariantList enumValues = fact->enumValues();
            for (qsizetype i = 0; i < enumStrings.size(); i++) {
                if (enumStrings[i].compare(change.proposedValue, Qt::CaseInsensitive) == 0) {
                    change.proposedValue = enumValues.value(i).toString();
                }
                if (enumValues.value(i).toString() == change.proposedValue) {
                    change.proposedLabel = enumStrings[i];
                }
            }
        }

        if (fact->readOnly()) {
            change.error = QStringLiteral("Parameter is read-only");
        } else if (change.proposedValue.isEmpty()) {
            change.error = QStringLiteral("No value given");
        } else {
            change.error = fact->validate(change.proposedValue, false);
        }
        changes.append(change);
    }

    auto *proposal = new QGCMcpProposal(_nextProposalId++, vehicle, args.value(u"summary").toString(), changes, this);
    if (proposal->validChangeCount() == 0) {
        isError = true;
        const QJsonObject json = proposal->toJson();
        proposal->deleteLater();
        return QJsonObject{{QStringLiteral("error"), QStringLiteral("None of the changes are valid; nothing was proposed.")},
                           {QStringLiteral("changes"), json.value(u"changes")}};
    }

    _proposals.insert(0, proposal);
    emit proposalAdded(proposal);

    QJsonObject result = proposal->toJson();
    if (vehicle->armed()) {
        result.insert(QStringLiteral("warning"), QStringLiteral("The vehicle is armed; the user cannot apply this until it is disarmed."));
    }
    return result;
}

QJsonObject QGCMcpServer::_toolProposalStatus(const QJsonObject &args, bool &isError)
{
    const int proposalId = args.value(u"proposal_id").toInt(-1);
    for (int i = 0; i < _proposals.count(); i++) {
        auto *proposal = _proposals.value<QGCMcpProposal*>(i);
        if (proposal && proposal->proposalId() == proposalId) {
            return proposal->toJson();
        }
    }
    isError = true;
    return _error(QStringLiteral("No proposal with id %1").arg(proposalId));
}

void QGCMcpServer::_activeVehicleChanged(Vehicle *vehicle)
{
    if (_rcVehicle) {
        (void) disconnect(_rcVehicle, &Vehicle::rcChannelsRawChanged, this, nullptr);
    }
    _rcVehicle = vehicle;
    _lastRcPwm.clear();
    if (vehicle) {
        (void) connect(vehicle, &Vehicle::rcChannelsRawChanged, this, [this](QVector<int> pwmValues) {
            _lastRcPwm = pwmValues;
        });
    }
}

QJsonObject QGCMcpServer::_toolRcChannels(bool &isError)
{
    QJsonObject errorResult;
    Vehicle *vehicle = _vehicleWithParams(isError, errorResult);
    if (!vehicle) {
        return errorResult;
    }

    ParameterManager *paramMgr = vehicle->parameterManager();
    auto paramInt = [paramMgr](const QString &name) -> int {
        return paramMgr->parameterExists(ParameterManager::defaultComponentId, name)
                   ? paramMgr->getParameter(ParameterManager::defaultComponentId, name)->rawValue().toInt()
                   : 0;
    };

    QHash<int, QStringList> functions;
    for (const QString &axis : {QStringLiteral("ROLL"), QStringLiteral("PITCH"), QStringLiteral("THROTTLE"), QStringLiteral("YAW")}) {
        const int channel = paramInt(QStringLiteral("RCMAP_") + axis);
        if (channel > 0) {
            functions[channel].append(QStringLiteral("RCMAP_") + axis);
        }
    }
    for (const QString &modeParam : {QStringLiteral("FLTMODE_CH"), QStringLiteral("MODE_CH")}) {
        const int channel = paramInt(modeParam);
        if (channel > 0) {
            functions[channel].append(modeParam);
        }
    }

    QJsonArray channels;
    const int count = std::max(static_cast<int>(_lastRcPwm.size()), 16);
    for (int channel = 1; channel <= count; channel++) {
        QJsonObject obj{{QStringLiteral("channel"), channel}};
        if (channel <= _lastRcPwm.size()) {
            obj.insert(QStringLiteral("pwm"), _lastRcPwm[channel - 1]);
        }
        const QString optionName = QStringLiteral("RC%1_OPTION").arg(channel);
        if (paramMgr->parameterExists(ParameterManager::defaultComponentId, optionName)) {
            Fact *option = paramMgr->getParameter(ParameterManager::defaultComponentId, optionName);
            if (option->rawValue().toInt() != 0) {
                obj.insert(QStringLiteral("option"), QStringLiteral("%1 = %2 (%3)").arg(optionName, option->cookedValueString(), option->enumStringValue()));
            }
        }
        if (functions.contains(channel)) {
            obj.insert(QStringLiteral("mapped_to"), QJsonArray::fromStringList(functions.value(channel)));
        }
        channels.append(obj);
    }

    return QJsonObject{
        {QStringLiteral("rc_received"), !_lastRcPwm.isEmpty()},
        {QStringLiteral("channels"), channels},
    };
}
