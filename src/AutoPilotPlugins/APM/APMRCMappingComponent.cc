#include "APMRCMappingComponent.h"

APMRCMappingComponent::APMRCMappingComponent(Vehicle *vehicle, AutoPilotPlugin *autopilot, QObject *parent)
    : VehicleComponent(vehicle, autopilot, AutoPilotPlugin::UnknownVehicleComponent, parent)
{
}
