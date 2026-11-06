#include "APMRCMappingController.h"

#include <cstdlib>

#include "Fact.h"
#include "ParameterManager.h"
#include "QGCLoggingCategory.h"
#include "Vehicle.h"

QGC_LOGGING_CATEGORY(APMRCMappingControllerLog, "AutoPilotPlugins.APMRCMappingController")

namespace {

struct PrimaryAxis {
    const char *label;
    const char *param;
};

constexpr PrimaryAxis kPrimaryAxes[] = {
    {QT_TRANSLATE_NOOP("APMRCMappingController", "Roll"),     "RCMAP_ROLL"},
    {QT_TRANSLATE_NOOP("APMRCMappingController", "Pitch"),    "RCMAP_PITCH"},
    {QT_TRANSLATE_NOOP("APMRCMappingController", "Throttle"), "RCMAP_THROTTLE"},
    {QT_TRANSLATE_NOOP("APMRCMappingController", "Yaw"),      "RCMAP_YAW"},
};

const QString kFlightModesFunction = QStringLiteral("Flight modes");

} // namespace

APMRCChannelInfo::APMRCChannelInfo(int channel_, QObject *parent)
    : QObject(parent)
    , channel(channel_)
{
}

void APMRCChannelInfo::setPwm(int pwm)
{
    if (_pwm != pwm) {
        _pwm = pwm;
        emit pwmChanged();
    }
}

void APMRCChannelInfo::setMoving(bool moving)
{
    if (_moving != moving) {
        _moving = moving;
        emit movingChanged();
    }
}

void APMRCChannelInfo::setMapping(const QString &primaryFunction, const QString &conflict)
{
    if (_primaryFunction != primaryFunction || _conflict != conflict) {
        _primaryFunction = primaryFunction;
        _conflict = conflict;
        emit mappingChanged();
    }
}

APMRCMappingController::APMRCMappingController(QObject *parent)
    : FactPanelController(parent)
{
    if (parameterExists(ParameterManager::defaultComponentId, QStringLiteral("FLTMODE_CH"))) {
        _flightModeParam = QStringLiteral("FLTMODE_CH");
    } else if (parameterExists(ParameterManager::defaultComponentId, QStringLiteral("MODE_CH"))) {
        _flightModeParam = QStringLiteral("MODE_CH");
    }

    for (int channel = 1; channel <= kMaxChannels; channel++) {
        auto *info = new APMRCChannelInfo(channel, this);
        info->optionFact = _fact(QStringLiteral("RC%1_OPTION").arg(channel));
        info->reversedFact = _fact(QStringLiteral("RC%1_REVERSED").arg(channel));
        info->minFact = _fact(QStringLiteral("RC%1_MIN").arg(channel));
        info->maxFact = _fact(QStringLiteral("RC%1_MAX").arg(channel));
        info->trimFact = _fact(QStringLiteral("RC%1_TRIM").arg(channel));
        if (info->optionFact) {
            (void) connect(info->optionFact, &Fact::rawValueChanged, this, &APMRCMappingController::_updateMappings);
        }
        _channels.append(info);
    }

    for (const PrimaryAxis &axis : kPrimaryAxes) {
        if (Fact *fact = _fact(QString::fromLatin1(axis.param))) {
            (void) connect(fact, &Fact::rawValueChanged, this, &APMRCMappingController::_updateMappings);
        }
    }
    if (Fact *fact = _fact(_flightModeParam)) {
        (void) connect(fact, &Fact::rawValueChanged, this, &APMRCMappingController::_updateMappings);
    }

    if (_vehicle) {
        (void) connect(_vehicle, &Vehicle::rcChannelsRawChanged, this, &APMRCMappingController::_rcChannelsChanged);
    }

    _movingTimer.setInterval(250);
    (void) connect(&_movingTimer, &QTimer::timeout, this, &APMRCMappingController::_expireMoving);
    _movingTimer.start();

    _updateMappings();
}

APMRCMappingController::~APMRCMappingController() = default;

QStringList APMRCMappingController::primaryAxes() const
{
    QStringList axes;
    for (const PrimaryAxis &axis : kPrimaryAxes) {
        axes.append(tr(axis.label));
    }
    if (!_flightModeParam.isEmpty()) {
        axes.append(tr("Flight modes"));
    }
    return axes;
}

Fact *APMRCMappingController::_fact(const QString &name) const
{
    if (name.isEmpty() || !parameterExists(ParameterManager::defaultComponentId, name)) {
        return nullptr;
    }
    return getParameterFact(ParameterManager::defaultComponentId, name, false);
}

void APMRCMappingController::_rcChannelsChanged(QVector<int> pwmValues)
{
    const int count = std::min(static_cast<int>(pwmValues.size()), kMaxChannels);
    if (_receivedChannels != count) {
        _receivedChannels = count;
        emit receivedChannelsChanged();
    }

    for (int i = 0; i < count; i++) {
        auto *info = _channels.value<APMRCChannelInfo*>(i);
        if (!info) {
            continue;
        }
        const int pwm = pwmValues[i];
        info->setPwm(pwm);

        if (pwm <= 0) {
            continue;
        }
        if (info->baselinePwm < 0) {
            info->baselinePwm = pwm;
            continue;
        }
        if (std::abs(pwm - info->baselinePwm) >= kMoveThresholdPwm) {
            info->baselinePwm = pwm;
            info->lastMoved.restart();
            info->setMoving(true);
            if (_lastMovedChannel != info->channel) {
                _lastMovedChannel = info->channel;
                emit lastMovedChannelChanged();
            }
        }
    }
}

void APMRCMappingController::_expireMoving()
{
    for (int i = 0; i < _channels.count(); i++) {
        auto *info = _channels.value<APMRCChannelInfo*>(i);
        if (info && info->moving() && info->lastMoved.isValid() && info->lastMoved.elapsed() > kMovingHoldMs) {
            info->setMoving(false);
        }
    }
}

QString APMRCMappingController::functionForChannel(int channel) const
{
    QStringList functions;
    for (const PrimaryAxis &axis : kPrimaryAxes) {
        Fact *fact = _fact(QString::fromLatin1(axis.param));
        if (fact && fact->rawValue().toInt() == channel) {
            functions.append(tr(axis.label));
        }
    }
    Fact *modeFact = _fact(_flightModeParam);
    if (modeFact && modeFact->rawValue().toInt() == channel) {
        functions.append(tr("Flight modes"));
    }
    return functions.join(QStringLiteral(" + "));
}

void APMRCMappingController::_updateMappings()
{
    for (int i = 0; i < _channels.count(); i++) {
        auto *info = _channels.value<APMRCChannelInfo*>(i);
        if (!info) {
            continue;
        }

        const QString primary = functionForChannel(info->channel);
        QString conflict;
        if (primary.contains(QStringLiteral(" + "))) {
            conflict = tr("This channel drives more than one function.");
        } else if (!primary.isEmpty() && info->optionFact && info->optionFact->rawValue().toInt() != 0) {
            conflict = tr("Also has an RC%1_OPTION assigned; ArduPilot will act on both.").arg(info->channel);
        }
        info->setMapping(primary, conflict);
    }
}

void APMRCMappingController::assignFunction(const QString &function, int channel)
{
    if (channel < 1 || channel > kMaxChannels) {
        return;
    }
    if (_vehicle && _vehicle->armed()) {
        qCWarning(APMRCMappingControllerLog) << "Refusing to change RC mapping while armed";
        return;
    }

    Fact *target = nullptr;
    QList<Fact*> axisFacts;
    for (const PrimaryAxis &axis : kPrimaryAxes) {
        Fact *fact = _fact(QString::fromLatin1(axis.param));
        if (!fact) {
            continue;
        }
        axisFacts.append(fact);
        if (function == tr(axis.label)) {
            target = fact;
        }
    }
    if (function == tr("Flight modes")) {
        target = _fact(_flightModeParam);
    }
    if (!target) {
        return;
    }

    const int previousChannel = target->rawValue().toInt();
    if (previousChannel == channel) {
        return;
    }

    // Moving a stick axis onto a channel another axis already uses swaps them, so no axis is left doubled up.
    if (axisFacts.contains(target)) {
        for (Fact *other : std::as_const(axisFacts)) {
            if (other != target && other->rawValue().toInt() == channel) {
                other->setRawValue(previousChannel);
            }
        }
    }
    target->setRawValue(channel);
}
