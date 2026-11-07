/**
 * The Omarchy bar plugin under omarchy/cad0p.pi-usage.
 *
 * The QML itself only runs inside Omarchy's shell (tests/omarchy-harness renders
 * it offscreen for a human to look at). What node can check is everything the
 * QML leans on: the pure UsageLogic.js module, evaluated here in a sandbox the
 * way QML loads it (plain script, no imports, no wall clock), the manifest the
 * shell's plugin registry reads, and that the shipped marks are the package's.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(ROOT, "omarchy", "cad0p.pi-usage");
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** @returns {any} */
function loadLogic() {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(PLUGIN, "UsageLogic.js"), "utf-8"), context, { filename: "UsageLogic.js" });
  return context;
}

const Logic = loadLogic();

/** @param {any} value */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** @param {number} ms */
const at = (ms) => new Date(NOW + ms).toISOString();

function claudeRecord(overrides = {}) {
  return {
    id: "pi-claude",
    name: "Claude",
    ready: true,
    tierLabel: "max 20x",
    usageStatusText: "",
    authHelpText: "",
    limits: [
      { label: "5h window", title: "Session", percent: 0.42, resetsAt: at(2 * HOUR) },
      { label: "Weekly window", title: "Weekly", percent: 0.93, resetsAt: at(DAY) },
    ],
    hasLocalStats: false,
    ...overrides,
  };
}

function goRecord() {
  return {
    id: "pi-opencode-go",
    name: "OP-Go",
    ready: true,
    tierLabel: "2 of 3 accounts",
    usageStatusText: "1 of 3 accounts unavailable",
    authHelpText: "#3 key rejected",
    limits: [
      { label: "#1 · Monthly window", title: "#1 · Monthly", percent: 1, resetsAt: at(18 * DAY) },
      { label: "#2 · Monthly window", title: "#2 · Monthly", percent: 0.9, resetsAt: at(19 * DAY) },
    ],
    accounts: [
      {
        id: "#1",
        ok: true,
        status: "",
        limits: [
          { label: "5h window", title: "Session", percent: 0, resetsAt: at(HOUR) },
          { label: "Monthly window", title: "Monthly", percent: 1, resetsAt: at(18 * DAY) },
        ],
      },
      {
        id: "#2",
        ok: true,
        status: "",
        limits: [
          { label: "5h window", title: "Session", percent: 0.02, resetsAt: at(10 * 60_000) },
          { label: "Weekly window", title: "Weekly", percent: 0.1, resetsAt: at(6 * DAY) },
          { label: "Monthly window", title: "Monthly", percent: 0.9, resetsAt: at(19 * DAY) },
        ],
      },
      { id: "#3", ok: false, status: "Credential rejected", limits: [] },
    ],
  };
}

test("the plugin manifest declares a loadable bar widget with complete settings", () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, "manifest.json"), "utf-8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.id, "cad0p.pi-usage");
  assert.match(manifest.id, /^[a-z0-9-]+\.[a-z0-9.-]+$/, "Omarchy plugin ids are <owner>.<name>");
  assert.deepEqual(manifest.kinds, ["bar-widget"]);
  assert.equal(manifest.license, "MIT");
  assert.ok(existsSync(join(PLUGIN, manifest.entryPoints.barWidget)), "the bar widget entry point exists");
  assert.ok(["left", "center", "right"].includes(manifest.barWidget.defaultSection));
  assert.equal(manifest.barWidget.allowMultiple, false);
  for (const field of manifest.barWidget.schema) {
    assert.ok(field.key in manifest.barWidget.defaults, `setting ${field.key} has a default`);
    assert.deepEqual(manifest.barWidget.defaults[field.key], field.defaultValue, `setting ${field.key} agrees with its schema default`);
  }
});

test("every QML file imports only modules the shell provides and every Logic call exists", () => {
  const qml = readdirSync(PLUGIN).filter((name) => name.endsWith(".qml"));
  assert.ok(qml.length > 0);
  const allowed = new Set(["QtQuick", "QtQuick.Controls", "Quickshell", "Quickshell.Io", "qs.Commons", "qs.Ui"]);
  for (const name of qml) {
    const text = readFileSync(join(PLUGIN, name), "utf-8");
    for (const match of text.matchAll(/^import\s+(\S+)/gm)) {
      const module = match[1];
      if (module.startsWith('"')) {
        assert.ok(existsSync(join(PLUGIN, module.slice(1, module.indexOf('"', 1)))), `${name} imports a file that exists: ${module}`);
        continue;
      }
      assert.ok(allowed.has(module), `${name} imports ${module}, which Omarchy's shell may not provide`);
    }
    for (const match of text.matchAll(/\bLogic\.([A-Za-z_]\w*)/g)) {
      assert.equal(typeof Logic[match[1]], "function", `${name} calls Logic.${match[1]}, which UsageLogic.js does not define`);
    }
  }
});

test("the plugin ships the package's provider marks byte for byte", () => {
  const source = join(ROOT, "src", "omarchy", "assets");
  for (const name of readdirSync(source).filter((file) => file.endsWith(".svg"))) {
    const shipped = join(PLUGIN, "assets", name);
    assert.ok(existsSync(shipped), `the plugin ships ${name}`);
    assert.ok(readFileSync(shipped).equals(readFileSync(join(source, name))), `${name} matches src/omarchy/assets`);
  }
});

test("the package publishes the plugin directory", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  assert.ok(pkg.files.includes("omarchy"), "package.json files must include omarchy/ so pi update ships the plugin");
});

test("providers follow the built-in rules: enabled, with data, sorted by id", () => {
  const records = [
    goRecord(),
    { id: "fireworks", name: "Fireworks", ready: false, hasLocalStats: false, usageStatusText: "Fireworks unavailable" },
    claudeRecord(),
    { id: "claude", name: "Claude Code", ready: true, limits: [], totalPrompts: 12, hasLocalStats: true },
    { id: "codex", name: "Codex", ready: true, limits: [{ title: "Weekly", percent: 0.1 }] },
    null,
    { name: "no id" },
  ];
  const settings = { providers: { codex: { enabled: false } } };
  const ids = plain(Logic.visibleProviders(records, settings)).map((/** @type {any} */ p) => p.providerId);
  assert.deepEqual(ids, ["claude", "pi-claude", "pi-opencode-go"]);
});

test("refresh, retry, visibility and state helpers retain their contracts", () => {
  assert.equal(Logic.queueUpdateKind("", "limits"), "limits");
  assert.equal(Logic.queueUpdateKind("limits", "normal"), "limits");
  assert.equal(Logic.queueUpdateKind("limits", "force"), "force");
  assert.deepEqual(plain(Logic.advisedRetryIds([
    { id: "claude", retryAdvised: true },
    { id: "codex", retryAdvised: true },
    { id: "pi-claude", retryAdvised: false },
  ], { providers: { codex: { enabled: false } } }, true)), ["claude"]);
  assert.equal(Logic.pluginVisible([]), false);
  assert.equal(Logic.pluginVisible([{}]), true);
  assert.equal(Logic.uiStateDirectory("/home/u/.local/state", ""), "/home/u/.local/state/omarchy/settings");
  assert.equal(Logic.uiStateDirectory("/home/u/.local/state", "/tmp/plugin-state"), "/tmp/plugin-state");
});

test("a retryAdvised record never runs collectors the setting forbids", () => {
  const records = [{ id: "claude", retryAdvised: true }, { id: "codex", retryAdvised: true }];
  assert.deepEqual(plain(Logic.advisedRetryIds(records, {}, false)), [], "nothing is retried while collectors are off");
  assert.deepEqual(plain(Logic.advisedRetryIds(records, {}, true)), ["claude", "codex"]);
  assert.equal(Logic.collectorsWanted("Off", false), false);
  assert.equal(Logic.collectorsWanted("Off", true), false);
  assert.equal(Logic.collectorsWanted("off", false), false, "a lowercase setting still means off");
  assert.equal(Logic.collectorsWanted("Auto", true), false, "Auto never doubles the built-in widget's work");
  assert.equal(Logic.collectorsWanted("Auto", false), true);
  assert.equal(Logic.collectorsWanted(undefined, true), false, "a missing setting reads as Auto");
  assert.equal(Logic.collectorsWanted(undefined, false), true);
  assert.equal(Logic.collectorsWanted("On", true), true, "On is the user asking for them explicitly");
  assert.equal(Logic.collectorsWanted(" on ", false), true);
});

test("QML binds provider sections to the tested logic instead of unconditional visibility", () => {
  const panel = readFileSync(join(PLUGIN, "Panel.qml"), "utf-8");
  const main = readFileSync(join(PLUGIN, "Main.qml"), "utf-8");
  const content = readFileSync(join(PLUGIN, "UsageContent.qml"), "utf-8");
  assert.match(panel, /visible: Logic\.pluginVisible\(providers\)/);
  assert.match(main, /uiStateDir: Logic\.uiStateDirectory\(stateHome, Quickshell\.env\("PI_USAGE_PANEL_STATE_DIR"\)\)/);
  assert.match(content, /readonly property var accountList: Logic\.accountRows\(provider\)/);
  assert.match(content, /readonly property var days: section\.provider \? Logic\.recentDayRows\(section\.provider\) : \[\]/);
  assert.match(content, /visible: section\.limitList\.length > 0/);
  assert.match(content, /visible: section\.accountList\.length > 0/);
  assert.match(content, /visible: section\.hasDays/);
  assert.match(content, /visible: section\.models\.length > 0/);
  assert.doesNotMatch(main, /\.cache\/pi-quota/);
  const harness = readFileSync(join(ROOT, "tests", "omarchy-harness", "render.sh"), "utf-8");
  assert.match(harness, /grep -Ei 'WARN\|WARNING\|ERROR\|TypeError\|ReferenceError'/);
  assert.match(harness, /scenario.*did not produce/);
  assert.match(readFileSync(join(ROOT, "tests", "omarchy-harness", "fixtures.mjs"), "utf-8"), /recentDays: \[null\]/);
  assert.match(harness, /if \[\[ ",\$SCENARIOS," == \*",adversarial,"\* \]\]/, "the adversarial fixture is copied only for its own scenario");
  assert.match(readFileSync(join(ROOT, "tests", "omarchy-harness", "shell.qml"), "utf-8"), /case "adversarial":/);
});

test("the retryAdvised timer obeys the same collector switch as the interval timer", () => {
  const main = readFileSync(join(PLUGIN, "Main.qml"), "utf-8");
  assert.match(main, /readonly property bool collectorsWanted: Logic\.collectorsWanted\(collectorsSetting, builtinOnBar\)/);
  assert.match(main, /onTriggered: if \(root\.collectorsWanted\) root\.runCollectors\("limits", root\.retryAgentIds\)/);
  assert.match(main, /Logic\.advisedRetryIds\(records, settings, collectorsWanted\)/);
  assert.match(main, /function runCollectors\(kind, agentIds\) \{[^}]*if \(!collectorsWanted\) return/, "runCollectors itself refuses to start when the switch is off");
  assert.match(main, /onCollectorsWantedChanged: scheduleLimitsRetry\(\)/);
});

test("two records that claim one id become one section, newest wins", () => {
  const older = { id: "codex", name: "Codex", updatedAt: "2026-11-03T10:00:00.000Z", ready: true, limits: [{ title: "Weekly", percent: 0.1 }] };
  const newer = { id: "codex", name: "Codex", updatedAt: "2026-11-03T11:00:00.000Z", ready: true, limits: [{ title: "Weekly", percent: 0.8 }] };
  const timeless = { id: "codex", name: "Codex", ready: true, limits: [{ title: "Weekly", percent: 0.2 }] };
  const providers = plain(Logic.visibleProviders([newer, timeless, older], {}));
  assert.equal(providers.length, 1, "one id is one section");
  assert.equal(providers[0].limits[0].percent, 0.8, "the newest updatedAt wins");
  const reordered = plain(Logic.visibleProviders([timeless, older, newer], {}));
  assert.deepEqual(reordered.map((/** @type {any} */ p) => p.providerId), ["codex"]);
  assert.equal(reordered[0].limits[0].percent, 0.8, "the newest wins when it arrives last, too");
});

test("a corrupt balance renders a bounded amount, never an exponent", () => {
  assert.equal(Logic.formatMoney(12.5, "USD"), "$12.50");
  assert.equal(Logic.formatMoney(Infinity, "USD"), "—");
  assert.equal(Logic.formatMoney(NaN, "EUR"), "—");
  assert.equal(Logic.formatMoney(1e308, "USD"), "$999999.99", "an absurd balance is clamped");
  assert.equal(Logic.formatMoney(-1e308, "USD"), "$-999999.99");
});

test("limit percentages are clamped to the normalized range", () => {
  const limits = plain(Logic.limitWindows([
    { title: "Huge", percent: 1e9 },
    { title: "Infinite", percent: Infinity },
    { title: "Normal", percent: 0.42 },
    { title: "Invalid", percent: NaN },
  ]));
  assert.deepEqual(limits.map((/** @type {any} */ w) => w.percent), [1, 1, 0.42]);
});

test("an absurd or non-finite token count never renders InfinityB", () => {
  assert.equal(Logic.formatTokenCount(Infinity), "—");
  assert.equal(Logic.formatTokenCount(-Infinity), "—");
  assert.equal(Logic.formatTokenCount(NaN), "—");
  assert.equal(Logic.formatTokenCount(1e299), "999.9B", "a corrupt count is clamped, not exponentiated");
  assert.equal(Logic.formatTokenCount(1e12), "999.9B");
  assert.equal(Logic.formatTokenCount(2_001_500), "2.0M");
  assert.equal(Logic.formatTokenCount(900), "900");
});

test("null recent-day entries are ignored by logic", () => {
  const provider = Logic.displayProvider({ id: "claude", hasLocalStats: true, recentDays: [null] });
  assert.deepEqual(plain(Logic.recentDayRows(provider)), []);
  assert.equal(Logic.weekPeak(provider), 0);
  assert.equal(Logic.hasDays(provider), false);
});

test("a single-account headline is its fullest window", () => {
  const head = plain(Logic.headline(Logic.displayProvider(claudeRecord())));
  assert.equal(head.title, "Weekly");
  assert.equal(head.percent, 0.93);
});

test("a multi-account headline is the healthy account with the most room left", () => {
  const p = Logic.displayProvider(goRecord());
  const head = plain(Logic.headline(p));
  assert.equal(head.accountId, "#2");
  assert.equal(head.title, "#2 · Monthly");
  assert.equal(head.percent, 0.9);
  assert.equal(Logic.statusChip(p), "1 down");
  assert.equal(Logic.headerMeta(p), "2 of 3 accounts");
});

test("a record written while the base was unlabelled reads it back as #1", () => {
  const record = goRecord();
  record.accounts = [
    { id: "", ok: true, status: "", limits: [{ label: "5h window", title: "Session", percent: 0.1, resetsAt: at(HOUR) }] },
    ...record.accounts.slice(1),
  ];
  record.limits = record.limits.slice(1);
  const rows = plain(Logic.accountRows(Logic.displayProvider(record)));
  assert.equal(rows[0].id, "#1", "the unlabelled base reads back as #1");
  assert.equal(plain(Logic.headline(Logic.displayProvider(record))).title, "#1 · Session", "the headline carries the slot prefix");
});

test("longestId returns the longest account id and tolerates junk", () => {
  assert.equal(Logic.longestId([{ id: "#1" }, { id: "#1-api" }, { id: "#2" }]), "#1-api");
  assert.equal(Logic.longestId([]), "");
  assert.equal(Logic.longestId(null), "");
  assert.equal(Logic.longestId({ id: "#1" }), "");
  assert.equal(Logic.longestId([null, { id: "#14" }, {}, { id: null }]), "#14");
});

test("the account label column is sized by the longest id, capped and elided", () => {
  const content = readFileSync(join(PLUGIN, "UsageContent.qml"), "utf-8");
  assert.match(content, /TextMetrics \{[\s\S]*?text: Logic\.longestId\(section\.accountList\)/, "the label column measures the longest account id");
  assert.match(content, /labelWidth: accountsSection\.labelWidth/, "each account row gets the section's computed width");
  assert.match(content, /width: accountRow\.labelWidth/, "the slot label takes that width");
  assert.match(content, /width \* 0\.35/, "a pathological label is capped at a share of the row");
  assert.match(content, /elide: Text\.ElideRight/, "…and elided");
});

test("every account keeps every window, and a failed account keeps its status", () => {
  const rows = plain(Logic.accountRows(Logic.displayProvider(goRecord())));
  assert.deepEqual(rows.map((/** @type {any} */ row) => row.id), ["#1", "#2", "#3"], "the base entry is #1");
  assert.deepEqual(rows[1].windows.map((/** @type {any} */ w) => Logic.windowTag(w.title)), ["session", "week", "month"]);
  assert.equal(rows[1].binding.title, "Monthly");
  assert.equal(rows[2].ok, false);
  assert.equal(rows[2].status, "Credential rejected");
  assert.deepEqual(rows[2].windows, []);
});

test("an unavailable provider says why on its header", () => {
  const p = Logic.displayProvider(claudeRecord({ ready: false, usageStatusText: "Sign-in expired", limits: [{ title: "Unavailable", percent: -1 }] }));
  assert.equal(Logic.headline(p), null, "the negative placeholder never becomes a headline");
  assert.equal(Logic.headerMeta(p), "Sign-in expired");
  assert.equal(Logic.statusChip(p), "Unavailable");
});

test("by default only the provider closest to its limit is expanded", () => {
  const providers = [
    Logic.displayProvider(goRecord()),
    Logic.displayProvider(claudeRecord()),
    Logic.displayProvider({ id: "pi-codex", name: "Codex", ready: true, limits: [{ title: "Monthly", percent: 0.34 }] }),
  ];
  const defaultId = Logic.defaultExpandedId(providers);
  assert.equal(defaultId, "pi-claude");
  assert.equal(Logic.isExpanded("pi-claude", {}, defaultId), true);
  assert.equal(Logic.isExpanded("pi-codex", {}, defaultId), false);
  assert.equal(Logic.defaultExpandedId([]), "");
});

test("an explicit expand or collapse sticks and survives a round trip through the state file", () => {
  let overrides = Logic.withExpanded({}, "pi-claude", false);
  overrides = Logic.withExpanded(overrides, "pi-codex", true);
  const restored = Logic.parseUiState(Logic.serializeUiState({ expanded: overrides })).expanded;
  assert.equal(Logic.isExpanded("pi-claude", restored, "pi-claude"), false);
  assert.equal(Logic.isExpanded("pi-codex", restored, "pi-claude"), true);
  assert.deepEqual(plain(Logic.parseUiState("not json")), { expanded: {} });
  assert.deepEqual(plain(Logic.parseUiState('{"expanded":{"a":true,"b":"yes"}}')), { expanded: { a: true } });
});

test("countdowns read like the built-in panel and like /usage", () => {
  assert.equal(Logic.formatDuration(DAY + 3 * HOUR + 5 * 60_000), "1d 3h");
  assert.equal(Logic.formatDuration(2 * HOUR + 4 * 60_000), "2h 4m");
  assert.equal(Logic.formatDuration(0), "now");
  assert.equal(Logic.compactDuration(10 * 60_000), "10m");
  assert.equal(Logic.compactDuration(5 * HOUR), "5h");
  assert.equal(Logic.compactDuration(19 * DAY + HOUR), "19d");
  assert.equal(Logic.resetMs({ resetAt: at(HOUR) }, NOW), HOUR);
  assert.equal(Logic.resetMs({ resetAt: "" }, NOW), -1);
});

test("tokens by model and by day follow the built-in formatting", () => {
  const p = Logic.displayProvider({
    id: "claude",
    name: "Claude Code",
    ready: true,
    hasLocalStats: true,
    recentDays: [{ date: "2026-11-02", messageCount: 2_500_000 }, { date: "2026-11-03", messageCount: 900 }],
    modelUsage: {
      "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "claude-opus-4-8": { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 2_000_000, cacheCreationInputTokens: 0 },
      "gpt-5.6-sol": { inputTokens: 300, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "deepseek-v4": { inputTokens: 200, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "kimi-k2": { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  });
  const rows = plain(Logic.modelRows(p));
  assert.deepEqual(rows.map((/** @type {any} */ row) => row.name), ["Opus 4.8", "GPT 5.6 Sol", "DeepSeek V4", "Kimi K2"], "heaviest four, built-in names");
  assert.equal(rows[0].total, 2_001_500);
  assert.equal(Logic.formatTokenCount(rows[0].total), "2.0M");
  assert.equal(Logic.formatTokenCount(900), "900");
  assert.equal(Logic.weekPeak(p), 2_500_000);
  assert.equal(Logic.hasDays(p), true);
  assert.equal(Logic.hasDays(Logic.displayProvider(claudeRecord())), false, "no local stats, no day chart");
  assert.deepEqual(plain(Logic.modelRows(Logic.displayProvider(claudeRecord()))), []);
});

test("marks resolve to the family's file, with a dark twin only where one ships", () => {
  assert.deepEqual(plain(Logic.iconCandidates("pi-claude", false)), ["assets/claude.svg", "assets/pi-claude.svg"]);
  assert.deepEqual(plain(Logic.iconCandidates("pi-codex", true)), ["assets/codex-light.svg", "assets/codex.svg", "assets/pi-codex.svg"]);
  assert.deepEqual(plain(Logic.iconCandidates("fireworks", true)), ["assets/fireworks.svg"]);
  for (const name of ["claude", "codex", "codex-light", "fireworks", "opencode-go", "antigravity", "github-actions"]) {
    assert.ok(existsSync(join(PLUGIN, "assets", `${name}.svg`)), `assets/${name}.svg ships`);
  }
});

test("a prepaid balance alarms in its last tenth, like the built-in", () => {
  const low = Logic.balanceValue({ remaining: 1.5, funded: 20, spent: 18.5 });
  assert.equal(Logic.balanceAlarming(low), true);
  assert.equal(Logic.balanceAlarming(Logic.balanceValue({ remaining: 15, funded: 20 })), false);
  assert.equal(Logic.balanceValue({ remaining: -1 }), null);
  assert.equal(Logic.formatMoney(1.5, "EUR"), "€1.50");
  assert.equal(Logic.balanceDetailText({ ...low, estimated: true }), "$18.50 spent of $20.00 funded · estimated");
});
