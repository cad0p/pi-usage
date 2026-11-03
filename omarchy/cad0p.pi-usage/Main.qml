import QtQuick
import Quickshell
import Quickshell.Io
import "UsageLogic.js" as Logic

// The data side of the AI Usage panel: discover every usage record in
// Omarchy's usage directory (pi-usage's pi-*.json and Omarchy's own
// claude/codex/fireworks records alike), watch them, keep the per-section
// expansion state, and trigger the publishers on demand.
//
// Discovery and the per-record watcher follow Omarchy's built-in Agents plugin
// (plugins/agents/Main.qml, MIT, by Omarchy).
Item {
  id: root
  visible: false

  property var settings: ({})
  // Live bar, used only to see whether the built-in Agents widget is also on
  // it (see collectorsWanted).
  property QtObject bar: null
  // file:// URL of the plugin directory, so the panel can find the pi-usage
  // CLI of the package it ships in.
  property string pluginDir: ""

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")
  // PI_QUOTA_OMARCHY_DIR is the writer's own override; honoring it here keeps
  // the two ends pointed at the same directory.
  readonly property string usageDir: Quickshell.env("PI_QUOTA_OMARCHY_DIR") || (stateHome + "/omarchy/agents/usage")
  readonly property string uiStateDir: Logic.uiStateDirectory(stateHome, Quickshell.env("PI_USAGE_PANEL_STATE_DIR"))
  readonly property string uiStatePath: uiStateDir + "/cad0p.pi-usage.json"

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // ------------------------------------------------------------- discovery

  property var recordIds: []
  property var agents: []
  property int dataRevision: 0

  Process {
    id: listProcess
    running: false
    command: ["find", root.usageDir, "-maxdepth", "1", "-name", "*.json", "-printf", "%f\n"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyListing(text)
    }
  }

  // New records are found by listing the directory again on a slow timer and
  // after every publisher run; each record's content is watched by its own
  // FileView, which is what actually moves the numbers.
  Timer {
    interval: 60000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.rescan()
  }

  function rescan() {
    if (!listProcess.running) listProcess.running = true
  }

  function applyListing(output) {
    var ids = []
    var lines = String(output || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var name = lines[i].trim()
      if (name.slice(-5) === ".json") ids.push(name.slice(0, -5))
    }
    ids.sort()
    if (JSON.stringify(ids) !== JSON.stringify(recordIds)) recordIds = ids
  }

  Instantiator {
    id: agentInstantiator
    model: root.recordIds

    delegate: Agent {
      required property var modelData
      agentId: modelData
      path: root.usageDir + "/" + modelData + ".json"
      onRecordChanged: root.recordsChanged()
    }

    onObjectAdded: (index, object) => root.rebuildAgents()
    onObjectRemoved: (index, object) => root.rebuildAgents()
  }

  function rebuildAgents() {
    var result = []
    for (var i = 0; i < agentInstantiator.count; i++) {
      var agent = agentInstantiator.objectAt(i)
      if (agent) result.push(agent)
    }
    agents = result
    recordsChanged()
  }

  function recordsChanged() {
    dataRevision++
    scheduleLimitsRetry()
  }

  property var retryAgentIds: []
  property string pendingUpdateKind: ""
  property bool pendingPublisher: false

  Timer {
    id: limitsRetry
    interval: 30000
    repeat: false
    // A retry is a collector run like any other: the same switch that gates the
    // interval timer gates this one, even if it flips while the retry waits.
    onTriggered: if (root.collectorsWanted) root.runCollectors("limits", root.retryAgentIds)
  }

  function scheduleLimitsRetry() {
    var records = []
    for (var i = 0; i < agents.length; i++) {
      var record = agents[i] ? agents[i].record : null
      if (record) records.push(record)
    }
    retryAgentIds = Logic.advisedRetryIds(records, settings, collectorsWanted)
    if (retryAgentIds.length > 0) limitsRetry.restart()
    else limitsRetry.stop()
  }

  // Turning the collectors off (or putting the built-in widget back on the
  // bar) cancels a retry that is already waiting.
  onCollectorsWantedChanged: scheduleLimitsRetry()

  readonly property var providers: {
    var rev = dataRevision
    var records = []
    for (var i = 0; i < agents.length; i++) if (agents[i] && agents[i].record) records.push(agents[i].record)
    return Logic.visibleProviders(records, settings)
  }

  readonly property string newestUpdate: {
    var rev = dataRevision
    var best = ""
    for (var i = 0; i < agents.length; i++) {
      var record = agents[i] ? agents[i].record : null
      var at = record && record.updatedAt ? String(record.updatedAt) : ""
      if (at !== "" && (best === "" || new Date(at).getTime() > new Date(best).getTime())) best = at
    }
    return best
  }

  // ------------------------------------------------------------ expansion

  property var expandedOverrides: ({})

  FileView {
    id: uiStateFile
    path: root.uiStatePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: root.expandedOverrides = Logic.parseUiState(text()).expanded
  }

  Process {
    id: uiStateMkdir
    running: false
    command: ["mkdir", "-p", root.uiStateDir]
    onExited: function(exitCode) {
      if (exitCode === 0) uiStateFile.setText(Logic.serializeUiState({ expanded: root.expandedOverrides }))
    }
  }

  Timer {
    id: uiStateSave
    interval: 400
    repeat: false
    onTriggered: if (!uiStateMkdir.running) uiStateMkdir.running = true
  }

  function setExpanded(id, expanded) {
    expandedOverrides = Logic.withExpanded(expandedOverrides, String(id), expanded)
    uiStateSave.restart()
  }

  // --------------------------------------------------------------- refresh
  //
  // pi-usage's records already have two writers: the systemd user timer
  // (./install.sh --omarchy-timer) and the Pi extension on every quota
  // refresh. A third periodic writer would only multiply the calls to the
  // usage endpoints, so the panel never schedules piquota itself; it runs it
  // when you ask for a refresh.
  //
  // Omarchy's own collectors are different: the built-in Agents widget is what
  // runs them. "Auto" runs them here only while that widget is not on the bar,
  // so replacing it keeps claude/codex/fireworks fresh and keeping both never
  // doubles the work.

  property string collectorsSetting: String(setting("omarchyCollectors", "Auto"))
  property int refreshIntervalSec: Math.max(30, Number(setting("refreshIntervalSec", 900)))
  property bool builtinOnBar: false
  readonly property bool collectorsWanted: Logic.collectorsWanted(collectorsSetting, builtinOnBar)
  readonly property bool refreshing: collectorProcess.running || publisherProcess.running

  function updateBuiltinOnBar() {
    var widgets = bar && typeof bar.moduleWidgets === "function" ? bar.moduleWidgets("omarchy.agents") : []
    builtinOnBar = !!widgets && widgets.length > 0
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    running: root.collectorsSetting !== "Off"
    repeat: true
    triggeredOnStart: true
    onTriggered: {
      root.updateBuiltinOnBar()
      if (root.collectorsWanted) root.runCollectors("normal")
    }
  }

  Process {
    id: collectorProcess
    running: false
    onExited: {
      root.rescan()
      if (root.pendingUpdateKind !== "") {
        var kind = root.pendingUpdateKind
        root.pendingUpdateKind = ""
        root.runCollectors(kind)
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("cad0p.pi-usage", text.trim())
    }
  }

  function collectorCommand(kind, agentIds) {
    var args = []
    if (kind === "force") args.push("--force")
    if (kind === "limits") args.push("--limits-only")
    var providerSettings = settings && settings.providers ? settings.providers : {}
    for (var id in providerSettings) {
      if (id.indexOf("pi-") === 0) continue
      if (providerSettings[id] && providerSettings[id].enabled === false) args.push("--except", id)
    }
    if (agentIds) {
      for (var i = 0; i < agentIds.length; i++) args.push(agentIds[i])
    }
    // Absent on a machine without Omarchy's collectors: nothing to run.
    return ["bash", "-c", "command -v omarchy-agent-usage-update >/dev/null 2>&1 || exit 0; exec omarchy-agent-usage-update \"$@\"", "omarchy-agent-usage-update"].concat(args)
  }

  function runCollectors(kind, agentIds) {
    // The one choke point every collector run passes through: the interval
    // timer, an explicit refresh and the retryAdvised retry.
    if (!collectorsWanted) return
    if (collectorProcess.running) {
      pendingUpdateKind = Logic.queueUpdateKind(pendingUpdateKind, kind)
      return
    }
    collectorProcess.command = collectorCommand(kind, agentIds)
    collectorProcess.running = true
  }

  Process {
    id: publisherProcess
    running: false
    onExited: {
      root.rescan()
      if (root.pendingPublisher) {
        root.pendingPublisher = false
        root.runPublisher()
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("cad0p.pi-usage", text.trim())
    }
  }

  function localPath(url) {
    var text = String(url || "")
    if (text.indexOf("file://") === 0) text = decodeURIComponent(text.slice(7))
    return text.replace(/\/+$/, "")
  }

  // The user's timer unit first, so a manual refresh runs with exactly the
  // environment the periodic one does (PI_QUOTA_CLAUDE_SOURCE and friends);
  // then the CLI of the package this plugin ships in; then piquota on PATH.
  function publisherCommand() {
    var script = [
      "if command -v systemctl >/dev/null 2>&1 && systemctl --user cat piquota-omarchy.service >/dev/null 2>&1; then",
      "  exec systemctl --user start piquota-omarchy.service",
      "fi",
      "cli=\"$(readlink -f \"$1\" 2>/dev/null)/../../bin/piquota.js\"",
      "if [ -f \"$cli\" ] && command -v node >/dev/null 2>&1; then exec node \"$cli\" omarchy; fi",
      "if command -v piquota >/dev/null 2>&1; then exec piquota omarchy; fi",
      "if [ -x \"$HOME/.local/bin/piquota\" ]; then exec \"$HOME/.local/bin/piquota\" omarchy; fi",
      "exit 0"
    ].join("\n")
    return ["bash", "-c", script, "pi-usage-refresh", localPath(pluginDir)]
  }

  function runPublisher() {
    if (publisherProcess.running) {
      pendingPublisher = true
      return
    }
    publisherProcess.command = publisherCommand()
    publisherProcess.running = true
  }

  // r, middle click, IPC refresh: everything, now.
  function refreshAll() {
    updateBuiltinOnBar()
    runPublisher()
    if (collectorsWanted) runCollectors("force")
  }

  // Opening the panel wants the numbers that go stale on the wire; Omarchy's
  // collectors reuse their recent transcript scans in this mode.
  function refreshOnOpen() {
    updateBuiltinOnBar()
    rescan()
    if (collectorsWanted) runCollectors("limits")
  }
}
