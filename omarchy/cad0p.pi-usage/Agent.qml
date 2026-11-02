import QtQuick
import Quickshell.Io

// One usage record, read straight off its data file. Carried over unchanged
// from Omarchy's built-in Agents plugin (plugins/agents/Agent.qml, MIT): a
// record that appears in the usage directory is a provider, whoever wrote it.
Item {
  id: root
  visible: false

  property string agentId: ""
  property string path: ""
  property var record: null

  FileView {
    path: root.path
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.parse(text())
    onLoadFailed: root.record = null
  }

  function parse(content) {
    try {
      var parsed = JSON.parse(String(content || ""))
      root.record = parsed && typeof parsed === "object" ? parsed : null
    } catch (e) {
      console.warn("cad0p.pi-usage", "Ignoring bad usage record", root.path, e)
      root.record = null
    }
  }
}
