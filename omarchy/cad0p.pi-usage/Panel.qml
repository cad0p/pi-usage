import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "UsageLogic.js" as Logic

// AI Usage: one bar icon and one popup for every AI subscription that has a
// usage record, each provider a collapsible section of a single scrolling
// list. Derived from Omarchy's built-in Agents panel (plugins/agents, MIT, by
// Omarchy): the same records, rows and type, with the tab switch replaced by
// sections and multi-account providers drawn account by account.
Panel {
  id: root
  moduleName: "cad0p.pi-usage"
  ipcTarget: "cad0p.pi-usage"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property string glyph: "󱚣"

  readonly property var providers: usage.providers

  // The icon lights up when any headline window is at 90% or a prepaid
  // balance is down to its last 10%, the built-in's alarm thresholds.
  readonly property bool alarming: {
    for (var i = 0; i < providers.length; i++) {
      var h = Logic.headline(providers[i])
      if ((h && h.percent >= 0.9) || Logic.balanceAlarming(providers[i].balance)) return true
    }
    return false
  }

  // Countdowns and "updated" read this instead of Date.now() so the panel
  // keeps telling the truth while it sits open.
  property double nowMs: Date.now()

  function refreshNow() { usage.refreshAll() }

  function launchAgent() {
    if (root.bar) root.bar.run("omarchy-agent --pick")
    root.close()
  }

  // Nothing to report, nothing in the bar, as with the built-in widget.
  visible: providers.length > 0
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    nowMs = Date.now()
    content.resetView()
    usage.refreshOnOpen()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Main {
    id: usage
    settings: root.settings
    bar: root.bar
    pluginDir: Qt.resolvedUrl(".")
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
    function expand(id: string): string { usage.setExpanded(id, true); return "ok" }
    function collapse(id: string): string { usage.setExpanded(id, false); return "ok" }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph
    active: root.alarming
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.launchAgent()
      else if (buttonCode === Qt.MiddleButton) root.refreshNow()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(content.contentImplicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      // j/k or arrows walk the section headers (paging through an open one
      // taller than the panel), Enter/Space fold or unfold, l/h unfold and
      // fold, r refreshes, Tab moves to the neighboring bar panel.
      onMoveRequested: function(dx, dy) {
        if (dy !== 0) content.moveCursor(dy)
        if (dx !== 0) content.setCursorExpanded(dx > 0)
      }
      onActivateRequested: content.toggleCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) { if (t === "r" || t === "R") root.refreshNow() }

      UsageContent {
        id: content
        anchors.fill: parent
        usage: usage
        foreground: root.foreground
        urgent: root.urgent
        fontFamily: root.fontFamily
        nowMs: root.nowMs
        fallbackGlyph: root.glyph
      }
    }
  }
}
