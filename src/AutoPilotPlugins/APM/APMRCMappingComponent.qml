import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import QGroundControl
import QGroundControl.Controls
import QGroundControl.FactControls

SetupPage {
    id:             rcMappingPage
    pageComponent:  pageComponent

    Component {
        id: pageComponent

        ColumnLayout {
            id:         mainLayout
            width:      availableWidth
            spacing:    ScreenTools.defaultFontPixelHeight / 2

            property var  _activeVehicle:   QGroundControl.multiVehicleManager.activeVehicle
            property bool _armed:           _activeVehicle ? _activeVehicle.armed : false

            readonly property int  _pwmMin:     800
            readonly property int  _pwmMax:     2200
            readonly property real _barWidth:   ScreenTools.defaultFontPixelWidth * 30

            APMRCMappingController { id: controller }

            QGCLabel {
                Layout.fillWidth:   true
                wrapMode:           Text.WordWrap
                text:               qsTr("Move a stick or flip a switch on your radio: its channel lights up. Use Assign to make it roll, pitch, throttle, yaw or the flight mode switch, or pick an RC option for switches. Changes to stick mapping take effect after a reboot.")
            }

            QGCLabel {
                Layout.fillWidth:   true
                visible:            _armed
                wrapMode:           Text.WordWrap
                color:              qgcPal.warningText
                text:               qsTr("Vehicle is armed. RC mapping changes are disabled until it is disarmed.")
            }

            QGCLabel {
                Layout.fillWidth:   true
                visible:            controller.receivedChannels === 0
                wrapMode:           Text.WordWrap
                color:              qgcPal.warningText
                text:               qsTr("No RC input received yet. Check that your receiver is bound and the vehicle is sending RC_CHANNELS.")
            }

            Rectangle {
                Layout.fillWidth:   true
                visible:            controller.lastMovedChannel > 0
                implicitHeight:     lastMovedLabel.implicitHeight + ScreenTools.defaultFontPixelHeight
                color:              qgcPal.accentSubtle
                radius:             ScreenTools.defaultFontPixelHeight / 4

                QGCLabel {
                    id:                 lastMovedLabel
                    anchors.centerIn:   parent
                    font.pointSize:     ScreenTools.largeFontPointSize
                    text: {
                        const fn = controller.functionForChannel(controller.lastMovedChannel)
                        return fn !== "" ? qsTr("Last moved: Channel %1 (%2)").arg(controller.lastMovedChannel).arg(fn)
                                         : qsTr("Last moved: Channel %1").arg(controller.lastMovedChannel)
                    }
                }
            }

            RowLayout {
                Layout.fillWidth:   true
                Layout.leftMargin:  ScreenTools.defaultFontPixelWidth / 2
                spacing:            ScreenTools.defaultFontPixelWidth

                QGCLabel { Layout.preferredWidth: ScreenTools.defaultFontPixelWidth * 3;  text: qsTr("Ch");       font.bold: true }
                QGCLabel { Layout.preferredWidth: _barWidth;                              text: qsTr("Live");     font.bold: true }
                QGCLabel { Layout.preferredWidth: ScreenTools.defaultFontPixelWidth * 5;  text: qsTr("PWM");      font.bold: true }
                QGCLabel { Layout.preferredWidth: ScreenTools.defaultFontPixelWidth * 18; text: qsTr("Function"); font.bold: true }
                QGCLabel { Layout.preferredWidth: ScreenTools.defaultFontPixelWidth * 16; text: qsTr("Assign");   font.bold: true }
                QGCLabel { Layout.preferredWidth: ScreenTools.defaultFontPixelWidth * 24; text: qsTr("RC option"); font.bold: true }
                QGCLabel { text: qsTr("Rev"); font.bold: true }
            }

            Repeater {
                model: controller.channels

                Rectangle {
                    id:                 rowRect
                    Layout.fillWidth:   true
                    implicitHeight:     rowLayout.implicitHeight + ScreenTools.defaultFontPixelHeight / 3
                    color:              object.moving ? qgcPal.accentSubtle : (index % 2 === 0 ? "transparent" : qgcPal.windowCard)
                    radius:             ScreenTools.defaultFontPixelHeight / 6

                    Behavior on color { ColorAnimation { duration: 300 } }

                    property var  _info:        object
                    property bool _haveInput:   index < controller.receivedChannels

                    RowLayout {
                        id:                     rowLayout
                        anchors.left:           parent.left
                        anchors.right:          parent.right
                        anchors.leftMargin:     ScreenTools.defaultFontPixelWidth / 2
                        anchors.verticalCenter: parent.verticalCenter
                        spacing:                ScreenTools.defaultFontPixelWidth

                        QGCLabel {
                            Layout.preferredWidth:  ScreenTools.defaultFontPixelWidth * 3
                            text:                   _info.channel
                            font.bold:              _info.moving
                        }

                        // Live PWM bar with min / trim / max markers
                        Item {
                            Layout.preferredWidth:  _barWidth
                            implicitHeight:         ScreenTools.defaultFontPixelHeight

                            function xFor(pwm) {
                                return Math.max(0, Math.min(1, (pwm - _pwmMin) / (_pwmMax - _pwmMin))) * width
                            }

                            Rectangle {
                                anchors.verticalCenter: parent.verticalCenter
                                width:                  parent.width
                                height:                 parent.height / 3
                                color:                  qgcPal.windowInset
                                radius:                 height / 2
                            }

                            Repeater {
                                model: [_info.minFact, _info.trimFact, _info.maxFact]

                                Rectangle {
                                    visible:    modelData !== null && modelData !== undefined
                                    x:          visible ? parent.xFor(modelData.rawValue) - width / 2 : 0
                                    width:      1
                                    height:     parent.height
                                    color:      qgcPal.textSecondary
                                }
                            }

                            Rectangle {
                                visible:                _haveInput && _info.pwm > 0
                                anchors.verticalCenter: parent.verticalCenter
                                x:                      parent.xFor(_info.pwm) - width / 2
                                width:                  parent.height * 0.7
                                height:                 width
                                radius:                 width / 2
                                color:                  _info.moving ? qgcPal.accent : qgcPal.textPrimary
                            }
                        }

                        QGCLabel {
                            Layout.preferredWidth:  ScreenTools.defaultFontPixelWidth * 5
                            text:                   _haveInput ? _info.pwm : "--"
                        }

                        QGCLabel {
                            Layout.preferredWidth:  ScreenTools.defaultFontPixelWidth * 18
                            text:                   _info.primaryFunction !== "" ? _info.primaryFunction : qsTr("—")
                            font.bold:              _info.primaryFunction !== ""
                            elide:                  Text.ElideRight
                        }

                        QGCComboBox {
                            Layout.preferredWidth:  ScreenTools.defaultFontPixelWidth * 16
                            enabled:                !_armed
                            model:                  [qsTr("Assign…")].concat(controller.primaryAxes)
                            currentIndex:           0
                            onActivated: (index) => {
                                if (index > 0) {
                                    controller.assignFunction(controller.primaryAxes[index - 1], _info.channel)
                                }
                                currentIndex = 0
                            }
                        }

                        FactComboBox {
                            Layout.preferredWidth:  ScreenTools.defaultFontPixelWidth * 24
                            visible:                _info.optionFact !== null
                            enabled:                !_armed
                            fact:                   _info.optionFact
                            indexModel:             false
                        }

                        FactCheckBox {
                            visible:    _info.reversedFact !== null
                            enabled:    !_armed
                            fact:       _info.reversedFact
                            text:       ""
                        }

                        QGCLabel {
                            Layout.fillWidth:   true
                            visible:            _info.conflict !== ""
                            text:               _info.conflict
                            color:              qgcPal.warningText
                            elide:              Text.ElideRight
                        }
                    }
                }
            }
        }
    }
}
