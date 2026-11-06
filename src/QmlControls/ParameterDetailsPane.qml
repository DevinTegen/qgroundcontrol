import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import QGroundControl
import QGroundControl.Controls

/// Full documentation for the selected parameter, shown under the parameter table.
Rectangle {
    id: root

    property var    fact:           null
    property string optionsText:    ""
    property string docsText:       ""

    readonly property bool _haveFact:   fact !== null && fact !== undefined
    readonly property bool _modified:   _haveFact && fact.defaultValueAvailable && !fact.valueEqualsDefault
    readonly property real _margins:    ScreenTools.defaultFontPixelHeight / 2

    signal editClicked()
    signal resetClicked()

    color:          qgcPal.windowCard
    border.color:   qgcPal.borderSubtle
    radius:         ScreenTools.defaultFontPixelHeight / 4

    QGCPalette { id: qgcPal; colorGroupEnabled: true }

    QGCLabel {
        anchors.centerIn:   parent
        visible:            !_haveFact
        text:               qsTr("Select a parameter to see its full documentation. Click a value to edit it.")
        color:              qgcPal.textSecondary
    }

    RowLayout {
        anchors.fill:       parent
        anchors.margins:    _margins
        spacing:            ScreenTools.defaultFontPixelWidth * 2
        visible:            _haveFact

        QGCFlickable {
            Layout.fillWidth:   true
            Layout.fillHeight:  true
            contentHeight:      detailsColumn.height
            clip:               true

            ColumnLayout {
                id:     detailsColumn
                width:  parent.width
                spacing: ScreenTools.defaultFontPixelHeight / 4

                QGCLabel {
                    Layout.fillWidth:   true
                    text:               _haveFact ? (fact.shortDescription !== "" ? fact.name + "  —  " + fact.shortDescription : fact.name) : ""
                    font.bold:          true
                    wrapMode:           Text.WordWrap
                }

                QGCLabel {
                    Layout.fillWidth:   true
                    wrapMode:           Text.WordWrap
                    text:               !_haveFact ? ""
                                        : fact.longDescription !== "" ? fact.longDescription
                                        : fact.shortDescription !== "" ? fact.shortDescription
                                        : qsTr("This parameter is not described in the loaded documentation (%1). It may have been added, renamed or removed in this firmware version.").arg(docsText)
                    color:              _haveFact && fact.longDescription === "" && fact.shortDescription === "" ? qgcPal.warningText : qgcPal.textPrimary
                }

                QGCLabel {
                    Layout.fillWidth:   true
                    visible:            optionsText !== ""
                    wrapMode:           Text.WordWrap
                    text:               qsTr("Options: %1").arg(optionsText)
                    color:              qgcPal.textSecondary
                }
            }
        }

        GridLayout {
            Layout.alignment:   Qt.AlignTop
            columns:            2
            columnSpacing:      ScreenTools.defaultFontPixelWidth
            rowSpacing:         0

            QGCLabel { text: qsTr("Value") }
            QGCLabel {
                text:       _haveFact ? fact.valueString + " " + fact.units : ""
                color:      _modified ? qgcPal.modifiedParamValue : qgcPal.textPrimary
                font.bold:  _modified
            }

            QGCLabel { text: qsTr("Default"); visible: _haveFact && fact.defaultValueAvailable }
            QGCLabel { text: _haveFact ? fact.defaultValueString + " " + fact.units : ""; visible: _haveFact && fact.defaultValueAvailable }

            QGCLabel { text: qsTr("Range"); visible: _haveFact && (!fact.minIsDefaultForType || !fact.maxIsDefaultForType) }
            QGCLabel {
                visible:    _haveFact && (!fact.minIsDefaultForType || !fact.maxIsDefaultForType)
                text:       _haveFact ? (fact.minIsDefaultForType ? "" : fact.minString) + " – " + (fact.maxIsDefaultForType ? "" : fact.maxString) : ""
            }

            QGCLabel { text: qsTr("Group"); visible: _haveFact }
            QGCLabel { text: _haveFact ? fact.group : ""; visible: _haveFact }

            QGCLabel { text: qsTr("Reboot"); visible: _haveFact && fact.vehicleRebootRequired }
            QGCLabel { text: qsTr("Required after change"); visible: _haveFact && fact.vehicleRebootRequired; color: qgcPal.warningText }

            QGCLabel { text: qsTr("Access"); visible: _haveFact && fact.readOnly }
            QGCLabel { text: qsTr("Read-only"); visible: _haveFact && fact.readOnly }
        }

        ColumnLayout {
            Layout.alignment:   Qt.AlignTop
            spacing:            _margins

            QGCButton {
                Layout.fillWidth:   true
                text:               qsTr("Edit…")
                enabled:            _haveFact && !fact.readOnly
                onClicked:          root.editClicked()
            }

            QGCButton {
                Layout.fillWidth:   true
                text:               qsTr("Reset to default")
                enabled:            _modified && !fact.readOnly
                onClicked:          root.resetClicked()
            }
        }
    }
}
