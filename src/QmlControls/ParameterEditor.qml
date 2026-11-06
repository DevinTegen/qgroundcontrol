import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

import QGroundControl
import QGroundControl.Controls
import QGroundControl.FactControls

Item {
    id:         _root

    property Fact   _editorDialogFact: Fact { }
    property int    _rowHeight:         ScreenTools.defaultFontPixelHeight * 2
    property int    _rowWidth:          10 // Dynamic adjusted at runtime
    property bool   _searchFilter:      searchText.text.trim() != "" || controller.showModifiedOnly || controller.showFavoritesOnly || controller.showUndocumentedOnly  ///< true: showing results of search
    property var    _searchResults      ///< List of parameter names from search results
    property var    _activeVehicle:     QGroundControl.multiVehicleManager.activeVehicle
    property bool   _showRCToParam:     _activeVehicle.px4Firmware
    property var    _appSettings:       QGroundControl.settingsManager.appSettings
    property var    _controller:        controller
    property var    _favorites:         controller.favoriteParameterNames
    property real   _margins:           ScreenTools.defaultFontPixelHeight / 2
    property var    _selectedFact:      null
    readonly property int _lastColumn:  6

    ParameterEditorController {
        id: controller
    }

    Timer {
        id:         clearTimer
        interval:   100;
        running:    false;
        repeat:     false
        onTriggered: {
            searchText.text = ""
            controller.searchText = ""
        }
    }

    QGCMenu {
        id:                 toolsMenu
        QGCMenuItem {
            text:           qsTr("Refresh")
            onTriggered:	controller.refresh()
        }
        QGCMenuItem {
            text:           qsTr("Reset all to firmware's defaults")
            onTriggered:    QGroundControl.showMessageDialog(_root, qsTr("Reset All"),
                                                         qsTr("Select Reset to reset all parameters to their defaults.\n\nNote that this will also completely reset everything, including UAVCAN nodes, all vehicle settings, setup and calibrations."),
                                                         Dialog.Cancel | Dialog.Reset,
                                                         function() { controller.resetAllToDefaults() })
        }
        QGCMenuItem {
            text:           qsTr("Reset to vehicle's configuration defaults")
            visible:        !_activeVehicle.apmFirmware
            onTriggered:    QGroundControl.showMessageDialog(_root, qsTr("Reset All"),
                                                         qsTr("Select Reset to reset all parameters to the vehicle's configuration defaults."),
                                                         Dialog.Cancel | Dialog.Reset,
                                                         function() { controller.resetAllToVehicleConfiguration() })
        }
        QGCMenuSeparator { }
        QGCMenuItem {
            objectName:     "parameterEditor_toolLoadFromFile"
            text:           qsTr("Load from file for review...")
            onTriggered: {
                fileDialog.title =          qsTr("Load Parameters")
                fileDialog.openForLoad()
            }
        }
        QGCMenuItem {
            text:           qsTr("Save to file...")
            onTriggered: {
                fileDialog.title =          qsTr("Save Parameters")
                fileDialog.openForSave()
            }
        }
        QGCMenuSeparator { }
        QGCMenuItem {
            text:           qsTr("Connect Claude…")
            onTriggered:    mcpConnectDialogFactory.open()
        }
        QGCMenuSeparator { }
        QGCMenuItem {
            text:           qsTr("Clear all favorites")
            onTriggered:    controller.clearAllFavorites()
        }
        QGCMenuSeparator { visible: _showRCToParam }
        QGCMenuItem {
            text:           qsTr("Clear all RC to Param")
            onTriggered:	_activeVehicle.clearAllParamMapRC()
            visible:        _showRCToParam
        }
        QGCMenuSeparator { }
        QGCMenuItem {
            text:           qsTr("Reboot Vehicle")
            onTriggered:    QGroundControl.showMessageDialog(_root, qsTr("Reboot Vehicle"),
                                                         qsTr("Select Ok to reboot vehicle."),
                                                         Dialog.Cancel | Dialog.Ok,
                                                         function() { _activeVehicle.rebootVehicle() })
        }
    }


    QGCFileDialog {
        id:             fileDialog
        folder:         _appSettings.parameterSavePath
        nameFilters:    [ qsTr("Parameter Files (*.%1)").arg(_appSettings.parameterFileExtension), qsTr("Mission Planner Files (*.param)"), qsTr("All Files (*)") ]

        onAcceptedForSave: (file) => {
            controller.saveToFile(file)
            close()
        }

        onAcceptedForLoad: (file) => {
            close()
            if (controller.buildDiffFromFile(file)) {
                parameterDiffDialogFactory.open()
            }
        }
    }

    QGCPopupDialogFactory {
        id: editorDialogFactory

        dialogComponent: editorDialogComponent
    }

    Component {
        id: editorDialogComponent

        ParameterEditorDialog {
            fact:           _editorDialogFact
            showRCToParam:  _showRCToParam
        }
    }

    QGCPopupDialogFactory {
        id:                 mcpConnectDialogFactory
        dialogComponent:    mcpConnectDialogComponent
    }

    Component {
        id: mcpConnectDialogComponent
        McpConnectDialog { }
    }

    QGCPopupDialogFactory {
        id: parameterDiffDialogFactory

        dialogComponent: parameterDiffDialog
    }

    Component {
        id: parameterDiffDialog

        ParameterDiffDialog {
            paramController: _controller
        }
    }

    RowLayout {
        id:             header
        anchors.left:   parent.left
        anchors.right:  parent.right

        RowLayout {
            Layout.alignment:   Qt.AlignLeft
            spacing:            ScreenTools.defaultFontPixelWidth

            QGCTextField {
                id:                     searchText
                placeholderText:        qsTr("Search")
                onDisplayTextChanged:   controller.searchText = displayText
            }

            QGCButton {
                text: qsTr("Clear")
                onClicked: {
                    if(ScreenTools.isMobile) {
                        Qt.inputMethod.hide();
                    }
                    clearTimer.start()
                }
            }

            QGCCheckBox {
                text:       qsTr("Hide read-only")
                checked:    controller.hideReadOnly
                onClicked:  controller.hideReadOnly = checked
            }
        }

        QGCButton {
            Layout.alignment:   Qt.AlignRight
            objectName:         "parameterEditor_toolsButton"
            text:               qsTr("Tools")
            onClicked:          toolsMenu.popup()
        }
    }

    RowLayout {
        id:                 docsStatus
        anchors.left:       parent.left
        anchors.right:      parent.right
        anchors.top:        header.bottom
        anchors.topMargin:  _margins / 2
        spacing:            ScreenTools.defaultFontPixelWidth

        QGCLabel {
            Layout.fillWidth:   true
            text:               qsTr("Parameter docs: %1").arg(controller.metaDataDescription)
            color:              qgcPal.textSecondary
            elide:              Text.ElideRight
        }

        QGCLabel {
            visible:    controller.undocumentedCount > 0
            text:       qsTr("%1 parameters on this vehicle are not in these docs").arg(controller.undocumentedCount)
            color:      qgcPal.warningText
        }
    }

    QGCGroupBox {
        id:                 paramGroupBox
        anchors.left:       parent.left
        anchors.right:      parent.right
        anchors.top:        docsStatus.bottom
        anchors.topMargin:  _margins
        anchors.bottom:     detailsPane.top
        anchors.bottomMargin: _margins
        showDividers:       false
        contentSpacing:     0

        onCurrentIndexChanged: {
            controller.showModifiedOnly     = (currentIndex === 1)
            controller.showFavoritesOnly    = (currentIndex === 2)
            controller.showUndocumentedOnly = (currentIndex === 3)
        }

        QGCGroupBoxTab { title: qsTr("Full List") }
        QGCGroupBoxTab { title: controller.defaultsAvailable ? qsTr("Modified (%1)").arg(controller.modifiedCount) : qsTr("Modified") }
        QGCGroupBoxTab { title: qsTr("Favorites") }
        QGCGroupBoxTab { title: qsTr("Undocumented (%1)").arg(controller.undocumentedCount) }

        QGCLabel {
            Layout.fillWidth:   true
            visible:            paramGroupBox.currentIndex === 1
            wrapMode:           Text.WordWrap
            color:              qgcPal.textSecondary
            text:               controller.defaultsAvailable
                                ? qsTr("Parameters whose current value differs from the firmware default. Select one to see the default and revert it.")
                                : qsTr("This vehicle has not reported its default values, so modified parameters can't be identified. ArduPilot 4.1 or newer reports them when parameters are downloaded over MAVLink FTP.")
        }

        Item {
            Layout.fillWidth:   true
            Layout.fillHeight:  true

            /// Group buttons
            QGCFlickable {
                id :                groupScroll
                width:              ScreenTools.defaultFontPixelWidth * 25
                anchors.top:        parent.top
                anchors.bottom:     parent.bottom
                clip:               true
                pixelAligned:       true
                contentHeight:      groupedViewCategoryColumn.height
                flickableDirection: Flickable.VerticalFlick
                visible:            !_searchFilter

                ColumnLayout {
                    id:             groupedViewCategoryColumn
                    anchors.left:   parent.left
                    anchors.right:  parent.right
                    spacing:        Math.ceil(ScreenTools.defaultFontPixelHeight * 0.25)

                    Repeater {
                        model: controller.categories

                        Column {
                            Layout.fillWidth:   true
                            spacing:            Math.ceil(ScreenTools.defaultFontPixelHeight * 0.25)


                            SectionHeader {
                                id:             categoryHeader
                                anchors.left:   parent.left
                                anchors.right:  parent.right
                                text:           object.name
                                checked:        object == controller.currentCategory

                                onCheckedChanged: {
                                    if (checked) {
                                        controller.currentCategory  = object
                                    }
                                }
                            }

                            Repeater {
                                model: categoryHeader.checked ? object.groups : 0

                                QGCButton {
                                    width:          ScreenTools.defaultFontPixelWidth * 25
                                    text:           object.name
                                    height:         _rowHeight
                                    checked:        object == controller.currentGroup
                                    autoExclusive:  true

                                    onClicked: {
                                        if (!checked) _rowWidth = 10
                                        checked = true
                                        controller.currentGroup = object
                                    }
                                }
                            }
                        }
                    }
                }
            }

            HorizontalHeaderView {
                id:                 headerView
                anchors.left:       tableView.left
                anchors.right:      tableView.right
                anchors.top:        parent.top
                syncView:           tableView
                clip:               true

                delegate: Rectangle {
                    implicitWidth:  column === 0 ? ScreenTools.implicitCheckBoxHeight + ScreenTools.defaultFontPixelWidth
                                                 : headerLabel.contentWidth + ScreenTools.defaultFontPixelWidth
                    implicitHeight: headerLabel.contentHeight + ScreenTools.defaultFontPixelHeight * 0.5
                    color:          qgcPal.windowCard

                    QGCLabel {
                        id:                     headerLabel
                        anchors.left:           parent.left
                        anchors.leftMargin:     ScreenTools.defaultFontPixelWidth / 2
                        anchors.verticalCenter: parent.verticalCenter
                        text:                   display
                        font.bold:              true
                    }

                    // Top border
                    Rectangle {
                        anchors.top:    parent.top
                        width:          parent.width
                        height:         1
                        color:          qgcPal.borderSubtle
                    }

                    // Left border
                    Rectangle {
                        anchors.left:   parent.left
                        height:         parent.height
                        width:          1
                        color:          qgcPal.borderSubtle
                    }

                    // Right border (last column only)
                    Rectangle {
                        anchors.right:  parent.right
                        height:         parent.height
                        width:          1
                        color:          qgcPal.borderSubtle
                        visible:        column == _lastColumn
                    }

                    // Bottom border
                    Rectangle {
                        anchors.bottom: parent.bottom
                        width:          parent.width
                        height:         1
                        color:          qgcPal.borderSubtle
                    }
                }
            }

            TableView {
                id:                 tableView
                anchors.leftMargin: ScreenTools.defaultFontPixelWidth
                anchors.top:        headerView.bottom
                anchors.bottom:     parent.bottom
                anchors.left:       _searchFilter ? parent.left : groupScroll.right
                anchors.right:      parent.right
                columnSpacing:      0
                rowSpacing:         0
                model:              controller.parameters
                contentWidth:       width
                clip:               true

                // Qt is supposed to adjust column widths automatically when larger widths come into view.
                // But it doesn't work. So we have to do it force a layout manually when we scroll.
                Timer {
                    id:             forceLayoutTimer
                    interval:       500
                    repeat:         false
                    onTriggered:    tableView.forceLayout()
                }

                onTopRowChanged: forceLayoutTimer.start()
                onModelChanged: {
                    positionViewAtRow(0, TableView.AlignLeft | TableView.AlignTop)
                    forceLayoutTimer.start()
                }

                delegate: Rectangle {
                    implicitWidth:  column === 0 ? ScreenTools.implicitCheckBoxHeight + ScreenTools.defaultFontPixelWidth
                                                 : column === 1 ? nameRow.implicitWidth + ScreenTools.defaultFontPixelWidth
                                                 : column === 2 ? ScreenTools.defaultFontPixelWidth * 16
                                                 : column === 3 ? Math.min(label.contentWidth, ScreenTools.defaultFontPixelWidth * 12) + ScreenTools.defaultFontPixelWidth
                                                 : column === 5 ? Math.min(label.contentWidth, ScreenTools.defaultFontPixelWidth * 34) + ScreenTools.defaultFontPixelWidth
                                                                : label.contentWidth + ScreenTools.defaultFontPixelWidth
                    implicitHeight: label.contentHeight + ScreenTools.defaultFontPixelHeight * 0.5
                    color:          fact === _selectedFact ? qgcPal.accentSubtle : (row % 2 === 0 ? "transparent" : qgcPal.windowCard)
                    clip:           true

                    // Bottom grid line
                    Rectangle {
                        anchors.bottom: parent.bottom
                        width:          parent.width
                        height:         1
                        color:          qgcPal.borderSubtle
                    }

                    // Left grid line
                    Rectangle {
                        anchors.left:   parent.left
                        height:         parent.height
                        width:          1
                        color:          qgcPal.borderSubtle
                    }

                    // Right grid line (last column only)
                    Rectangle {
                        anchors.right:  parent.right
                        height:         parent.height
                        width:          1
                        color:          qgcPal.borderSubtle
                        visible:        column == _lastColumn
                    }

                    QGCCheckBox {
                        visible:                column === 0
                        anchors.centerIn:       parent
                        checked:                _root._favorites.indexOf(fact.name) >= 0
                        z:                      1
                        onClicked:              controller.toggleFavorite(fact.name)
                    }

                    Row {
                        id:                     nameRow
                        visible:                column === 1
                        anchors.left:           parent.left
                        anchors.leftMargin:     ScreenTools.defaultFontPixelWidth / 2
                        anchors.verticalCenter: parent.verticalCenter
                        spacing:               lockIcon.visible ? ScreenTools.defaultFontPixelWidth / 3 : 0

                        QGCLabel {
                            text:               column === 1 ? display : ""
                            anchors.verticalCenter: parent.verticalCenter
                        }

                        QGCColoredImage {
                            id:                 lockIcon
                            visible:            fact.readOnly
                            source:             "qrc:/InstrumentValueIcons/lock-closed.svg"
                            color:              qgcPal.textPrimary
                            width:              ScreenTools.defaultFontPixelHeight * 0.8
                            height:             width
                            sourceSize.width:   width
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    QGCLabel {
                        id:                 label
                        visible:            column !== 0 && column !== 1
                        anchors.left:       parent.left
                        anchors.leftMargin: ScreenTools.defaultFontPixelWidth / 2
                        anchors.verticalCenter: parent.verticalCenter
                        width:              column == 2 ? ScreenTools.defaultFontPixelWidth * 15
                                            : column == 3 ? Math.min(implicitWidth, ScreenTools.defaultFontPixelWidth * 12)
                                            : column == 5 ? Math.min(implicitWidth, ScreenTools.defaultFontPixelWidth * 34)
                                                          : implicitWidth
                        text:               column == 2 ? col1String() : display
                        color:              column == 2 && fact.defaultValueAvailable && !fact.valueEqualsDefault ? qgcPal.modifiedParamValue
                                            : (column == 3 || column == 4 || column == 5) ? qgcPal.textSecondary : qgcPal.textPrimary
                        font.bold:          column == 2 && fact.defaultValueAvailable && !fact.valueEqualsDefault
                        maximumLineCount:   1
                        elide:              (column == 2 || column == 3 || column == 5) ? Text.ElideRight : Text.ElideNone

                        function col1String() {
                            if (fact.enumStrings.length === 0) {
                                return fact.valueString + " " + fact.units
                            }
                            if (fact.bitmaskStrings.length != 0) {
                                return fact.selectedBitmaskStrings.join(',')
                            }
                            return fact.enumStringValue
                        }
                    }

                    // Value column edits directly (Mission Planner style); other columns select the row for the details pane
                    QGCMouseArea {
                        anchors.fill: parent
                        visible:      column !== 0
                        onClicked: mouse => {
                            _selectedFact = fact
                            if (column === 2) {
                                _editorDialogFact = fact
                                editorDialogFactory.open()
                            }
                        }
                        onDoubleClicked: mouse => {
                            _editorDialogFact = fact
                            editorDialogFactory.open()
                        }
                    }
                }
            }
        }
    }

    ParameterDetailsPane {
        id:             detailsPane
        anchors.left:   parent.left
        anchors.right:  parent.right
        anchors.bottom: parent.bottom
        height:         ScreenTools.defaultFontPixelHeight * 11
        fact:           _selectedFact
        optionsText:    _selectedFact ? controller.optionsText(_selectedFact) : ""
        docsText:       controller.metaDataDescription

        onEditClicked: {
            _editorDialogFact = _selectedFact
            editorDialogFactory.open()
        }
        onResetClicked: controller.resetToDefault(_selectedFact)
    }
}
