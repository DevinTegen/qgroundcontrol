import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

import QGroundControl
import QGroundControl.Controls

/// Shows how to connect a desktop AI assistant (Claude) to QGC's local MCP server, plus recent proposals.
QGCPopupDialog {
    id:         root
    title:      qsTr("Connect Claude")
    buttons:    Dialog.Close

    property var _server: QGroundControl.mcpServer

    QGCPalette { id: qgcPal; colorGroupEnabled: true }

    QGCPopupDialogFactory {
        id:                 proposalDialogFactory
        dialogComponent:    proposalDialogComponent
    }

    Component {
        id: proposalDialogComponent
        McpProposalDialog { }
    }

    ColumnLayout {
        width:      Math.min(ScreenTools.defaultFontPixelWidth * 100, root.maxContentAvailableWidth)
        spacing:    ScreenTools.defaultFontPixelHeight / 2

        QGCCheckBox {
            text:       qsTr("Allow Claude to connect to QGroundControl")
            checked:    _server.enabled
            onClicked:  _server.enabled = checked
        }

        QGCLabel {
            Layout.fillWidth:   true
            wrapMode:           Text.WordWrap
            color:              _server.running ? qgcPal.successText : qgcPal.warningText
            text:               _server.running ? qsTr("Listening on %1 (this computer only). Requests received: %2").arg(_server.endpointUrl).arg(_server.clientRequests)
                                                : (_server.errorString !== "" ? _server.errorString : qsTr("Not running"))
        }

        QGCLabel {
            Layout.fillWidth:   true
            wrapMode:           Text.WordWrap
            text:               qsTr("Claude can read your vehicle's status and parameters and propose changes. Every change is shown to you here first and is only written when you click Apply. Changes are refused while armed. This uses your Claude subscription through the Claude desktop app; no API key is needed.")
        }

        QGCLabel {
            Layout.topMargin:   ScreenTools.defaultFontPixelHeight / 2
            font.bold:          true
            text:               qsTr("Claude desktop app")
        }

        QGCLabel {
            Layout.fillWidth:   true
            wrapMode:           Text.WordWrap
            text:               qsTr("In Claude, open Settings → Developer → Edit Config, merge the following into claude_desktop_config.json, save, and restart Claude. Keep QGroundControl running.")
        }

        QGCTextField {
            id:                 configText
            Layout.fillWidth:   true
            readOnly:           true
            text:               _server.desktopConfig
        }

        QGCButton {
            text:       qsTr("Copy config")
            onClicked:  QGroundControl.copyToClipboard(_server.desktopConfig)
        }

        QGCLabel {
            Layout.topMargin:   ScreenTools.defaultFontPixelHeight / 2
            font.bold:          true
            text:               qsTr("Claude Code")
        }

        RowLayout {
            Layout.fillWidth: true

            QGCLabel {
                Layout.fillWidth:   true
                wrapMode:           Text.WrapAnywhere
                font.family:        ScreenTools.fixedFontFamily
                text:               "claude mcp add --transport http qgroundcontrol " + _server.endpointUrl
            }

            QGCButton {
                text:       qsTr("Copy")
                onClicked:  QGroundControl.copyToClipboard("claude mcp add --transport http qgroundcontrol " + _server.endpointUrl)
            }
        }

        QGCLabel {
            Layout.topMargin:   ScreenTools.defaultFontPixelHeight / 2
            font.bold:          true
            visible:            _server.proposals.count > 0
            text:               qsTr("Proposals this session")
        }

        Repeater {
            model: _server.proposals

            RowLayout {
                Layout.fillWidth: true

                QGCLabel {
                    Layout.fillWidth:   true
                    elide:              Text.ElideRight
                    text:               "#" + object.proposalId + "  " + object.summary
                }

                QGCLabel {
                    text:   object.statusText
                    color:  object.pending ? qgcPal.warningText : qgcPal.textSecondary
                }

                QGCButton {
                    text:       object.pending ? qsTr("Review") : qsTr("View")
                    onClicked:  proposalDialogFactory.open({ proposal: object })
                }
            }
        }
    }
}
