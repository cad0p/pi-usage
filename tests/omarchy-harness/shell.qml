import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "plugin"
import "builtin" as Builtin

// Offscreen harness for the AI Usage panel. render.sh builds a throwaway
// Quickshell config root around this file (Omarchy's Commons and Ui linked
// in, the plugin as ./plugin, the built-in Agents plugin as ./builtin) and
// runs it with QT_QPA_PLATFORM=offscreen against fixture records. Each
// scenario sets up the panel, waits for it to settle and grabs the card to
// a PNG; nothing is shown on a real output and no shell is touched.
ShellRoot {
  id: harness

  readonly property string outDir: Quickshell.env("HARNESS_OUT") || "/tmp"
  readonly property var scenarioNames: String(Quickshell.env("HARNESS_SCENARIOS") || "default").split(",")
  readonly property string prefix: Quickshell.env("HARNESS_PREFIX") || ""
  property int step: -1
  // The built-in panel runs only when a builtin scenario asks for it, so the
  // plugin's own scenarios log nothing but the plugin's warnings.
  readonly property bool wantsBuiltin: scenarioNames.some(function(name) { return name.indexOf("builtin") === 0 })

  readonly property color foreground: Color.bar.text
  readonly property color urgent: Color.bar.active
  readonly property int padding: Style.spacing.popupPadding
  readonly property var borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
  readonly property real inset: padding * 2 + Border.top(borderSpec) + Border.bottom(borderSpec)
  readonly property real cardWidth: Style.space(380) + padding * 2 + Border.left(borderSpec) + Border.right(borderSpec)
  readonly property real cap: Style.space(640)

  function scenario(name) {
    switch (name) {
    case "default":
      usage.expandedOverrides = ({})
      content.resetView()
      break
    case "all-collapsed":
    case "all-expanded":
      var map = {}
      for (var i = 0; i < usage.providers.length; i++) map[usage.providers[i].providerId] = name === "all-expanded"
      usage.expandedOverrides = map
      content.resetView()
      break
    case "scroll-middle":
      content.flick.contentY = Math.max(0, (content.flick.contentHeight - content.flick.height) / 2)
      break
    case "scroll-bottom":
      content.flick.contentY = Math.max(0, content.flick.contentHeight - content.flick.height)
      break
    case "cursor":
      usage.expandedOverrides = ({})
      content.resetView()
      content.moveCursor(1)
      content.moveCursor(1)
      break
    case "keys":
      // j Enter j Enter: fold the open first section, walk to the second
      // header and unfold it.
      usage.expandedOverrides = ({})
      content.resetView()
      content.moveCursor(1)
      content.toggleCursor()
      content.moveCursor(1)
      content.toggleCursor()
      break
    case "builtin":
    case "builtin-2":
    case "builtin-3":
      builtinView.visible = true
      card.visible = false
      if (builtinLoader.item) builtinLoader.item.selectProvider(name === "builtin" ? 0 : (name === "builtin-2" ? 1 : 2))
      break
    }
  }

  function next() {
    step++
    if (step >= scenarioNames.length) {
      Qt.quit()
      return
    }
    builtinView.visible = false
    card.visible = true
    scenario(scenarioNames[step])
    settle.restart()
  }

  Timer {
    id: start
    interval: 1500
    running: true
    onTriggered: harness.next()
  }

  Timer {
    id: settle
    interval: 700
    onTriggered: {
      var name = harness.scenarioNames[harness.step]
      var target = name.indexOf("builtin") === 0 ? builtinView : frame
      target.grabToImage(function(result) {
        var path = harness.outDir + "/" + harness.prefix + name + ".png"
        result.saveToFile(path)
        console.log("harness: wrote " + path + " (" + Math.round(target.width) + "x" + Math.round(target.height) + ", content " + Math.round(content.contentImplicitHeight) + ")")
        harness.next()
      })
    }
  }

  FloatingWindow {
    id: win
    implicitWidth: Math.round(harness.cardWidth + 40)
    implicitHeight: Math.round(harness.cap + 40)
    color: Qt.darker(Color.background, 1.2)
    visible: true

    Main {
      id: usage
      settings: ({ omarchyCollectors: "Off" })
      pluginDir: Qt.resolvedUrl("plugin")
    }

    Item {
      id: frame
      width: win.width
      height: Math.round(card.height + 40)

      Rectangle { anchors.fill: parent; color: win.color }

      BorderSurface {
        id: card
        x: 20
        y: 20
        width: harness.cardWidth
        height: Math.min(content.contentImplicitHeight + harness.inset, harness.cap)
        color: Color.popups.background
        borderSpec: harness.borderSpec
        radius: Style.cornerRadius

        UsageContent {
          id: content
          anchors.fill: parent
          anchors.margins: harness.padding + Border.top(harness.borderSpec)
          usage: usage
          foreground: harness.foreground
          urgent: harness.urgent
        }
      }
    }

    // The built-in Agents panel's own content, for side-by-side comparison
    // (render.sh strips its popup chrome, see there).
    Item {
      id: builtinView
      visible: false
      width: win.width
      height: Math.round(builtinCard.height + 40)

      Rectangle { anchors.fill: parent; color: win.color }

      BorderSurface {
        id: builtinCard
        x: 20
        y: 20
        width: harness.cardWidth
        height: Math.min((builtinLoader.item ? builtinLoader.item.panelContentHeight : 0) + harness.inset, harness.cap)
        color: Color.popups.background
        borderSpec: harness.borderSpec
        radius: Style.cornerRadius

        Loader {
          id: builtinLoader
          active: harness.wantsBuiltin
          anchors.fill: parent
          anchors.margins: harness.padding + Border.top(harness.borderSpec)
          sourceComponent: Component { Builtin.Panel {} }
        }
      }
    }
  }
}
