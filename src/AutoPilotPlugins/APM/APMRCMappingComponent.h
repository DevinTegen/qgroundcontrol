#pragma once

#include "VehicleComponent.h"

/// Live RC input view for mapping radio sticks/switches onto ArduPilot RCMAP_*, flight mode and RCn_OPTION params.
class APMRCMappingComponent : public VehicleComponent
{
    Q_OBJECT

public:
    explicit APMRCMappingComponent(Vehicle *vehicle, AutoPilotPlugin *autopilot, QObject *parent = nullptr);

    QStringList setupCompleteChangedTriggerList() const final { return QStringList(); }

    QString name() const final { return _name; }
    QString description() const final { return tr("See every RC channel move live and assign sticks and switches to functions."); }
    QString iconResource() const final { return QStringLiteral("/qmlimages/RadioComponentIcon.png"); }
    bool requiresSetup() const final { return false; }
    bool setupComplete() const final { return true; }
    QUrl setupSource() const final { return QUrl::fromUserInput(QStringLiteral("qrc:/qml/QGroundControl/AutoPilotPlugins/APM/APMRCMappingComponent.qml")); }
    QUrl summaryQmlSource() const final { return QUrl::fromUserInput(QStringLiteral("qrc:/qml/QGroundControl/AutoPilotPlugins/APM/APMRCMappingComponentSummary.qml")); }

private:
    const QString _name = tr("RC Mapping");
};
