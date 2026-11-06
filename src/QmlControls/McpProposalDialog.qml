import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

import QGroundControl
import QGroundControl.Controls

/// Review dialog for parameter changes proposed by an AI assistant over MCP. Apply writes the checked changes;
/// Cancel leaves the proposal pending; Reject tells the assistant no.
QGCPopupDialog {
    id:         root
    title:      qsTr("Claude proposes parameter changes")
    buttons:    Dialog.Apply | Dialog.Cancel

    required property var proposal

    property var  _activeVehicle:   QGroundControl.multiVehicleManager.activeVehicle
    property bool _armed:           _activeVehicle ? _activeVehicle.armed : false
    property int  _selectedCount:   {
        let count = 0
        for (const change of proposal.changes) {
            if (change.selected && change.error === "") {
                count++
            }
        }
        return count
    }

    acceptButtonEnabled: proposal.pending && !_armed && _selectedCount > 0

    onAccepted: proposal.apply()

    QGCPalette { id: qgcPal; colorGroupEnabled: true }

    ColumnLayout {
        width:      Math.min(ScreenTools.defaultFontPixelWidth * 110, root.maxContentAvailableWidth)
        spacing:    ScreenTools.defaultFontPixelHeight / 2

        QGCLabel {
            Layout.fillWidth:   true
            wrapMode:           Text.WordWrap
            font.bold:          true
            text:               proposal.summary !== "" ? proposal.summary : qsTr("No summary given.")
        }

        QGCLabel {
            Layout.fillWidth:   true
            wrapMode:           Text.WordWrap
            color:              qgcPal.textSecondary
            text:               qsTr("Nothing is written to the vehicle until you click Apply. Uncheck any change you don't want.")
        }

        QGCLabel {
            Layout.fillWidth:   true
            visible:            _armed
            wrapMode:           Text.WordWrap
            color:              qgcPal.warningText
            text:               qsTr("The vehicle is armed. Disarm it to apply these changes.")
        }

        QGCFlickable {
            Layout.fillWidth:       true
            Layout.preferredHeight: Math.min(changesColumn.height, root.maxContentAvailableHeight * 0.6)
            contentHeight:          changesColumn.height
            clip:                   true

            ColumnLayout {
                id:         changesColumn
                width:      parent.width
                spacing:    ScreenTools.defaultFontPixelHeight / 2

                Repeater {
                    model: proposal.changes

                    Rectangle {
                        Layout.fillWidth:   true
                        implicitHeight:     changeLayout.implicitHeight + ScreenTools.defaultFontPixelHeight / 2
                        color:              qgcPal.windowCard
                        radius:             ScreenTools.defaultFontPixelHeight / 4

                        RowLayout {
                            id:                 changeLayout
                            anchors.left:       parent.left
                            anchors.right:      parent.right
                            anchors.margins:    ScreenTools.defaultFontPixelWidth
                            anchors.verticalCenter: parent.verticalCenter
                            spacing:            ScreenTools.defaultFontPixelWidth

                            QGCCheckBox {
                                Layout.alignment:   Qt.AlignTop
                                enabled:            proposal.pending && modelData.error === ""
                                checked:            modelData.selected
                                onClicked:          proposal.setChangeSelected(index, checked)
                            }

                            ColumnLayout {
                                Layout.fillWidth:   true
                                spacing:            0

                                QGCLabel {
                                    Layout.fillWidth:   true
                                    font.bold:          true
                                    elide:              Text.ElideRight
                                    text:               modelData.description !== "" ? modelData.name + "  —  " + modelData.description : modelData.name
                                }

                                QGCLabel {
                                    text: {
                                        const proposed = modelData.proposedLabel !== "" ? modelData.proposedValue + " (" + modelData.proposedLabel + ")" : modelData.proposedValue
                                        return qsTr("%1  →  %2 %3").arg(modelData.currentValue).arg(proposed).arg(modelData.units)
                                    }
                                    color: qgcPal.modifiedParamValue
                                }

                                QGCLabel {
                                    Layout.fillWidth:   true
                                    visible:            modelData.reason !== ""
                                    wrapMode:           Text.WordWrap
                                    color:              qgcPal.textSecondary
                                    text:               modelData.reason
                                }

                                QGCLabel {
                                    visible:    modelData.rebootRequired
                                    text:       qsTr("Reboot required after change")
                                    color:      qgcPal.warningText
                                }

                                QGCLabel {
                                    Layout.fillWidth:   true
                                    visible:            modelData.error !== ""
                                    wrapMode:           Text.WordWrap
                                    color:              qgcPal.errorText
                                    text:               qsTr("Can't apply: %1").arg(modelData.error)
                                }
                            }
                        }
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth:   true

            QGCLabel {
                Layout.fillWidth:   true
                text:               proposal.statusText
                color:              qgcPal.textSecondary
            }

            QGCButton {
                text:       qsTr("Reject")
                enabled:    proposal.pending
                onClicked: {
                    proposal.reject()
                    root.close()
                }
            }
        }
    }
}
