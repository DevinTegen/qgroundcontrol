import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import QGroundControl
import QGroundControl.FactControls
import QGroundControl.Controls

Item {
    implicitWidth: mainLayout.implicitWidth
    implicitHeight: mainLayout.implicitHeight
    width: parent.width  // grows when Loader is wider than implicitWidth

    APMRCMappingController { id: controller }

    ColumnLayout {
        id: mainLayout
        width: parent.width
        spacing: 0

        Repeater {
            model: controller.primaryAxes

            VehicleSummaryRow {
                required property string modelData

                labelText: modelData
                valueText: {
                    for (let ch = 1; ch <= controller.channels.count; ch++) {
                        if (controller.functionForChannel(ch).split(" + ").indexOf(modelData) >= 0) {
                            return qsTr("Channel %1").arg(ch)
                        }
                    }
                    return qsTr("Not mapped")
                }
            }
        }
    }
}
