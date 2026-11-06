#include "APMExactParamDocs.h"

#include <QtCore/QDir>
#include <QtCore/QFile>
#include <QtCore/QFileInfo>
#include <QtCore/QHash>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QRegularExpression>
#include <QtCore/QStandardPaths>
#include <QtCore/QXmlStreamReader>

#include "MAVLinkLib.h"
#include "QGCFileDownload.h"
#include "QGCFileHelper.h"
#include "QGCLoggingCategory.h"
#include "Vehicle.h"

QGC_LOGGING_CATEGORY(APMExactParamDocsLog, "FirmwarePlugin.APMExactParamDocs")

namespace {

constexpr int kDownloadTimeoutMs = 60000;

QString _apmExactDocsCacheDir()
{
    return QStandardPaths::writableLocation(QStandardPaths::CacheLocation) + QStringLiteral("/ParameterMetaData/APMExact");
}

QString _apmExactDocsFileName(const QString &vehicleDocsName, const QVersionNumber &version)
{
    return QStringLiteral("%1-%2.json").arg(vehicleDocsName, version.toString());
}

/// Parses ArduPilot's "0:Disabled,1:Enabled" field form into {"0":"Disabled","1":"Enabled"}.
QJsonObject _apmDocsParseCodeList(const QString &text)
{
    QJsonObject obj;
    for (const QString &item : text.split(u',', Qt::SkipEmptyParts)) {
        const int sep = item.indexOf(u':');
        if (sep <= 0) {
            continue;
        }
        obj.insert(item.left(sep).trimmed(), item.mid(sep + 1).trimmed());
    }
    return obj;
}

QJsonObject _apmDocsReadCodeElements(QXmlStreamReader &xml, QStringView childName)
{
    QJsonObject obj;
    while (xml.readNextStartElement()) {
        if (xml.name() == childName) {
            const QString code = xml.attributes().value(QStringLiteral("code")).toString();
            const QString text = xml.readElementText().trimmed();
            if (!code.isEmpty()) {
                obj.insert(code, text);
            }
        } else {
            xml.skipCurrentElement();
        }
    }
    return obj;
}

QJsonObject _apmDocsReadParam(QXmlStreamReader &xml, QString &name)
{
    const QXmlStreamAttributes attrs = xml.attributes();
    name = attrs.value(QStringLiteral("name")).toString();
    const qsizetype prefixSep = name.indexOf(u':');
    if (prefixSep >= 0) {
        name = name.mid(prefixSep + 1);
    }

    QJsonObject param;
    if (attrs.hasAttribute(QStringLiteral("humanName"))) {
        param.insert(QStringLiteral("DisplayName"), attrs.value(QStringLiteral("humanName")).toString());
    }
    if (attrs.hasAttribute(QStringLiteral("documentation"))) {
        param.insert(QStringLiteral("Description"), attrs.value(QStringLiteral("documentation")).toString());
    }
    if (attrs.hasAttribute(QStringLiteral("user"))) {
        param.insert(QStringLiteral("User"), attrs.value(QStringLiteral("user")).toString());
    }

    while (xml.readNextStartElement()) {
        if (xml.name() == u"field") {
            const QString fieldName = xml.attributes().value(QStringLiteral("name")).toString();
            const QString text = xml.readElementText().trimmed();
            if (fieldName == u"Range") {
                static const QRegularExpression whitespace(QStringLiteral("\\s+"));
                const QStringList parts = text.split(whitespace, Qt::SkipEmptyParts);
                if (parts.size() == 2) {
                    param.insert(QStringLiteral("Range"),
                                 QJsonObject{{QStringLiteral("low"), parts[0]}, {QStringLiteral("high"), parts[1]}});
                }
            } else if (fieldName == u"ReadOnly" || fieldName == u"RebootRequired") {
                param.insert(fieldName, text.compare(u"true", Qt::CaseInsensitive) == 0);
            } else if (fieldName == u"Values" || fieldName == u"Bitmask") {
                // ArduPilot emits Bitmask both as <bitmask> and as text; keep the structured form when present.
                const QJsonObject codes = _apmDocsParseCodeList(text);
                if (!codes.isEmpty() && !param.contains(fieldName)) {
                    param.insert(fieldName, codes);
                }
            } else if (!fieldName.isEmpty()) {
                param.insert(fieldName, text);
            }
        } else if (xml.name() == u"values") {
            const QJsonObject codes = _apmDocsReadCodeElements(xml, u"value");
            if (!codes.isEmpty()) {
                param.insert(QStringLiteral("Values"), codes);
            }
        } else if (xml.name() == u"bitmask") {
            const QJsonObject codes = _apmDocsReadCodeElements(xml, u"bit");
            if (!codes.isEmpty()) {
                param.insert(QStringLiteral("Bitmask"), codes);
            }
        } else {
            xml.skipCurrentElement();
        }
    }

    return param;
}

} // namespace

APMExactParamDocs::APMExactParamDocs(Vehicle *vehicle, const QString &vehicleDocsName, QObject *parent)
    : QObject(parent)
    , _vehicle(vehicle)
    , _vehicleDocsName(vehicleDocsName)
{
    if (vehicle) {
        _version = QVersionNumber(vehicle->firmwareMajorVersion(),
                                  vehicle->firmwareMinorVersion(),
                                  vehicle->firmwarePatchVersion());
    }
}

QString APMExactParamDocs::cachedFile(const QString &vehicleDocsName, const QVersionNumber &version)
{
    if (vehicleDocsName.isEmpty() || version.segmentCount() < 3) {
        return QString();
    }
    const QString path = QDir(_apmExactDocsCacheDir()).filePath(_apmExactDocsFileName(vehicleDocsName, version));
    return QFileInfo::exists(path) ? path : QString();
}

bool APMExactParamDocs::versionHasPublishedDocs(const Vehicle *vehicle)
{
    if (!vehicle || vehicle->isOfflineEditingVehicle()) {
        return false;
    }
    if (vehicle->firmwareVersionType() != FIRMWARE_VERSION_TYPE_OFFICIAL) {
        return false;
    }
    // ArduPilot's versioned archive starts at 4.1.
    const int major = vehicle->firmwareMajorVersion();
    const int minor = vehicle->firmwareMinorVersion();
    return (major > 4) || (major == 4 && minor >= 1);
}

QString APMExactParamDocs::describeMetaDataFile(const QString &metaDataFile)
{
    if (metaDataFile.isEmpty()) {
        return tr("No parameter documentation loaded");
    }

    const QFileInfo info(metaDataFile);
    if (QDir::cleanPath(info.absolutePath()) == QDir::cleanPath(_apmExactDocsCacheDir())) {
        // "Plane-4.6.3.json"
        const QString base = info.completeBaseName();
        const qsizetype dash = base.indexOf(u'-');
        if (dash > 0) {
            return tr("%1 %2 — exact match for this firmware").arg(base.left(dash), base.mid(dash + 1));
        }
        return tr("%1 — exact match for this firmware").arg(base);
    }

    static const QRegularExpression bundled(QStringLiteral("APMParameterFactMetaData\\.(\\w+)\\.(\\d+)\\.(\\d+)\\.json$"));
    const QRegularExpressionMatch match = bundled.match(metaDataFile);
    if (match.hasMatch()) {
        return tr("%1 %2.%3 — bundled, nearest version (patch-level changes may be missing)")
            .arg(match.captured(1), match.captured(2), match.captured(3));
    }

    return tr("%1 — cached from firmware image").arg(info.fileName());
}

bool APMExactParamDocs::convertXmlToJson(const QByteArray &xmlData, QByteArray &json, QString *errorString)
{
    QXmlStreamReader xml(xmlData);
    QHash<QString, QJsonObject> groups;
    QString currentGroup;
    int paramCount = 0;

    while (!xml.atEnd()) {
        xml.readNext();
        if (!xml.isStartElement()) {
            continue;
        }
        if (xml.name() == u"parameters") {
            currentGroup = xml.attributes().value(QStringLiteral("name")).toString();
        } else if (xml.name() == u"param") {
            QString name;
            const QJsonObject param = _apmDocsReadParam(xml, name);
            if (name.isEmpty()) {
                continue;
            }
            const QString group = currentGroup.isEmpty() ? QStringLiteral("Misc") : currentGroup;
            groups[group].insert(name, param);
            paramCount++;
        }
    }

    if (xml.hasError()) {
        if (errorString) {
            *errorString = xml.errorString();
        }
        return false;
    }
    if (paramCount == 0) {
        if (errorString) {
            *errorString = QStringLiteral("No parameters found in ArduPilot docs");
        }
        return false;
    }

    QJsonObject root;
    for (auto it = groups.constBegin(); it != groups.constEnd(); ++it) {
        root.insert(it.key(), it.value());
    }
    json = QJsonDocument(root).toJson(QJsonDocument::Compact);
    return true;
}

QString APMExactParamDocs::_url() const
{
    return QStringLiteral("https://autotest.ardupilot.org/Parameters/versioned/%1/stable-%2/apm.pdef.xml")
        .arg(_vehicleDocsName, _version.toString());
}

void APMExactParamDocs::fetchIfNeeded()
{
    if (_started || !_vehicle || _vehicleDocsName.isEmpty() || !versionHasPublishedDocs(_vehicle)) {
        return;
    }
    if (!cachedFile(_vehicleDocsName, _version).isEmpty()) {
        return;
    }

    _started = true;
    auto *download = new QGCFileDownload(this);
    download->setTimeout(kDownloadTimeoutMs);
    (void) connect(download, &QGCFileDownload::finished, download, &QObject::deleteLater);
    (void) connect(download, &QGCFileDownload::finished, this, &APMExactParamDocs::_downloadFinished);

    qCDebug(APMExactParamDocsLog) << "Fetching exact parameter docs:" << _url();
    if (!download->start(_url())) {
        qCWarning(APMExactParamDocsLog) << "Exact parameter docs download did not start:" << download->errorString();
        download->deleteLater();
    }
}

void APMExactParamDocs::_downloadFinished(bool success, const QString &localFile, const QString &errorMsg)
{
    if (!success) {
        // Offline or the release isn't published (yet): the bundled nearest version stays in use.
        qCDebug(APMExactParamDocsLog) << "Exact parameter docs unavailable:" << _url() << errorMsg;
        return;
    }

    QFile file(localFile);
    if (!file.open(QIODevice::ReadOnly)) {
        qCWarning(APMExactParamDocsLog) << "Cannot read downloaded docs:" << localFile << file.errorString();
        return;
    }
    const QByteArray xml = file.readAll();
    file.close();
    (void) QFile::remove(localFile);

    QByteArray json;
    QString error;
    if (!convertXmlToJson(xml, json, &error)) {
        qCWarning(APMExactParamDocsLog) << "Cannot convert ArduPilot docs:" << _url() << error;
        return;
    }

    QGCFileHelper::ensureDirectoryExists(_apmExactDocsCacheDir());
    const QString cachePath = QDir(_apmExactDocsCacheDir()).filePath(_apmExactDocsFileName(_vehicleDocsName, _version));
    if (!QGCFileHelper::atomicWrite(cachePath, json)) {
        qCWarning(APMExactParamDocsLog) << "Failed to cache exact parameter docs:" << cachePath;
        return;
    }

    qCDebug(APMExactParamDocsLog) << "Cached exact parameter docs:" << cachePath;
    emit docsReady(cachePath);
}
