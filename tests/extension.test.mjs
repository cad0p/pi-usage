/**
 * Extension contract tests.
 *
 * The extension is loaded through Node's TypeScript type-stripping, so these run
 * without the Pi TUI. They pin the parts that are easy to break silently:
 * the default surface, the used-percent semantics, the brand colours, and the
 * fact that nothing touches the LLM context.
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mergeLastGood } from "../src/sticky.js";

const EXTENSION = new URL("../extensions/quota-panel.ts", import.meta.url).href;
const RAIL_PATCH_MODULE = fileURLToPath(new URL("../src/gentle-pi/rail-patch.js", import.meta.url));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "pi-quota-extension-cache-"));
// These tests must never edit the real gentle-pi package, so the default lookup is
// pointed at an empty directory. The rail tests opt back in with their own fixture.
process.env.PI_QUOTA_GENTLE_PI_DIR = mkdtempSync(join(tmpdir(), "pi-quota-extension-no-gentle-pi-"));

/** Strips SGR sequences so assertions can talk about visible text. */
const plain = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, "");

function renderWidget(widget, theme = { fg: (_key, text) => text, bold: (text) => text }, width = 100, tui = { terminal: {} }) {
  if (Array.isArray(widget)) return widget;
  return widget(tui, theme).render(width);
}

const SIDEBAR_STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
const STOCK_RAIL = 'const sections = ["footer", "agents", "todo"].map((key) => key);\n';

const PATCHED_RAIL = 'const sections = ["footer", "agents", "todo", "quota"].map((key) => key);\n';

/** A throwaway gentle-pi package so the rail tests never touch the real install. */
function makeGentlePiFixture(patched = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-gentle-pi-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "shell-sidebar-layout.ts"), patched ? PATCHED_RAIL : STOCK_RAIL, "utf-8");
  return dir;
}

/**
 * A throwaway CLI tree holding the rail patcher where the extension looks for it,
 * so `PI_QUOTA_BIN` can point the extension at it instead of the real install.
 */
function makeCliTree() {
  const root = mkdtempSync(join(tmpdir(), "pi-quota-cli-tree-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "gentle-pi"), { recursive: true });
  writeFileSync(join(root, "bin", "piquota.js"), "#!/usr/bin/env node\n", "utf-8");
  copyFileSync(RAIL_PATCH_MODULE, join(root, "src", "gentle-pi", "rail-patch.js"));
  return join(root, "bin", "piquota.js");
}

/**
 * Run a body with `PI_QUOTA_BIN` and `PI_QUOTA_GENTLE_PI_DIR` pointed at fixtures,
 * restoring both afterwards so the other tests keep their hermetic defaults.
 */
async function withRailFixtures(body, { patched = false } = {}) {
  const gentlePiDir = makeGentlePiFixture(patched);
  const previousBin = process.env.PI_QUOTA_BIN;
  const previousDir = process.env.PI_QUOTA_GENTLE_PI_DIR;
  process.env.PI_QUOTA_BIN = makeCliTree();
  process.env.PI_QUOTA_GENTLE_PI_DIR = gentlePiDir;
  try {
    await body({ gentlePiDir, layoutPath: join(gentlePiDir, "lib", "shell-sidebar-layout.ts") });
  } finally {
    if (previousBin === undefined) delete process.env.PI_QUOTA_BIN;
    else process.env.PI_QUOTA_BIN = previousBin;
    if (previousDir === undefined) delete process.env.PI_QUOTA_GENTLE_PI_DIR;
    else process.env.PI_QUOTA_GENTLE_PI_DIR = previousDir;
  }
}

const REPORT = {
  providers: [
    {
      family: "claude",
      label: "Claude (Pi)",
      primaryWindowId: "5h",
      account: "fixture@example.com",
      plan: null,
      windows: [
        { id: "5h", label: "5h window", usedPercent: 4, remainingPercent: 96, resetsAt: null, resetsInSec: 3600, note: null },
        { id: "weekly", label: "Weekly window", usedPercent: 11, remainingPercent: 89, resetsAt: null, resetsInSec: 500000, note: null },
      ],
      error: null,
      ok: true,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: 600,
    },
    {
      family: "codex",
      label: "Codex (Pi)",
      primaryWindowId: "5h",
      account: "fixture@example.com",
      plan: "plus",
      windows: [
        { id: "5h", label: "5h window", usedPercent: 19, remainingPercent: 81, resetsAt: null, resetsInSec: 7200, note: null },
      ],
      error: null,
      ok: true,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: 600,
    },
    {
      family: "antigravity",
      label: "Antigravity (Pi)",
      primaryWindowId: "gemini-5h",
      account: "fixture@example.com",
      plan: null,
      windows: [
        { id: "gemini-5h", label: "Gemini · 5h", usedPercent: 62, remainingPercent: 38, resetsAt: null, resetsInSec: 300, note: null },
        { id: "gemini-weekly", label: "Gemini · weekly", usedPercent: 3, remainingPercent: 97, resetsAt: null, resetsInSec: 900000, note: null },
      ],
      error: null,
      ok: true,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: 600,
    },
    {
      family: "opencode-go",
      label: "OpenCode Go (Pi)",
      primaryWindowId: null,
      account: "workspace wrk_x",
      plan: "Go subscription",
      windows: [],
      error: "no auth cookie",
      ok: false,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: null,
    },
  ],
  generatedAt: "2030-01-01T00:00:00.000Z",
  sources: ["/tmp/auth.json"],
  warnings: [],
};

/**
 * Minimal fake of the ExtensionAPI subset the extension uses.
 *
 * @param {{ report?: unknown, fail?: boolean }} [options]
 */
function withFamilies(report) {
  return {
    ...report,
    byFamily:
      report.byFamily ??
      Object.fromEntries(report.providers.map((provider) => [provider.family, report.providers.filter((other) => other.family === provider.family)])),
  };
}

function makeHarness(options = {}) {
  const commands = [];
  const handlers = new Map();
  const statuses = [];
  const widgets = [];
  const notifications = [];
  const forbidden = [];

  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    exec: async () => {
      if (options.fail) throw new Error("piquota exploded");
      return { stdout: JSON.stringify(withFamilies(options.report ?? REPORT)), stderr: "", code: 0 };
    },
    registerCommand: (name, definition) => commands.push({ name, definition }),
    registerTool: () => forbidden.push("registerTool"),
    registerFlag: () => forbidden.push("registerFlag"),
    sendMessage: () => forbidden.push("sendMessage"),
    appendEntry: () => forbidden.push("appendEntry"),
    registerEntryRenderer: () => forbidden.push("registerEntryRenderer"),
  };

  const ctx = {
    hasUI: true,
    ui: {
      theme: options.theme ?? { fg: (_key, text) => text, bold: (text) => text },
      setStatus: (_key, value) => statuses.push(value),
      setWidget: (_key, value) => widgets.push(value),
      notify: (message) => notifications.push(message),
    },
  };

  return { pi, ctx, commands, handlers, statuses, widgets, notifications, forbidden };
}

/**
 * Start the session and, unless `surface` is null, turn that surface on the way a
 * user would. Nothing is pinned at session start, so tests that inspect a widget
 * must ask for it first.
 */
async function startSession(harness, surface = "box") {
  await harness.handlers.get("session_start")({}, harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (surface) {
    const usage = harness.commands.find((command) => command.name === "usage");
    await usage.definition.handler(surface, harness.ctx);
  }
}

/** Let the stubbed CLI settle: every frame is rendered from live state. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The visible text of one frame. */
const frameText = (overlay, width = 90) => plain(overlay.component.render(width).join("\n"));

/**
 * Mount the fullscreen overlay the way pi does: `ctx.ui.custom` builds the
 * component with a tui, a theme, keybindings and a completion callback, and
 * resolves when the view calls done(). Completion disposes the component, as pi
 * does, so the extension's cleanup is exercised too.
 */
function installOverlay(harness, { rows = 40 } = {}) {
  const overlays = [];
  harness.ctx.ui.custom = (factory, options) => {
    let finish;
    const promise = new Promise((resolve) => {
      finish = resolve;
    });
    const record = { options, rows, doneCalls: 0, renders: 0 };
    record.tui = {
      terminal: { rows },
      requestRender: () => {
        record.renders += 1;
      },
    };
    record.component = factory(record.tui, harness.ctx.ui.theme, {}, () => {
      record.doneCalls += 1;
      record.component.dispose?.();
      finish(undefined);
    });
    overlays.push(record);
    return promise;
  };
  return overlays;
}

/**
 * A report whose Now rows are wider than 64 columns: three windows per account
 * with real reset countdowns, and a warning long enough to wrap. This is the
 * shape that used to lose its tail to a hard clip.
 */
function wideReport() {
  const account = (slot) => ({
    family: "opencode-go",
    label: "OpenCode Go (Pi)",
    primaryWindowId: "5h",
    account: slot === 1 ? "" : `#${slot}`,
    plan: "Go subscription",
    windows: [
      { id: "5h", label: "5h window", usedPercent: 0, remainingPercent: 100, resetsAt: null, resetsInSec: 18_000, note: null },
      { id: "weekly", label: "Weekly window", usedPercent: 0, remainingPercent: 100, resetsAt: null, resetsInSec: 432_000, note: null },
      { id: "monthly", label: "Monthly window", usedPercent: 100, remainingPercent: 0, resetsAt: null, resetsInSec: 1_555_200, note: null },
    ],
    error: null,
    ok: true,
    updatedAt: "2030-01-01T00:00:00.000Z",
    expiresInMin: null,
  });
  return {
    generatedAt: "2030-01-01T00:00:00.000Z",
    sources: [],
    warnings: ["claude: the upstream probe fell back to a cached observation while the token expires in 3 minutes"],
    providers: [account(1), account(2)],
  };
}

/** The legend rows at the bottom of a frame, from the first row that names a key. */
function legendRows(text) {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const first = lines.findIndex((line) => line.includes("↑↓/jk move"));
  return first === -1 ? [] : lines.slice(first);
}

/**
 * The report as the extension holds it *today*. `todayTotalTokens` is the day the
 * report was generated on, so a test that merges the live day must stamp the
 * report with the clock it froze — a report generated on another day is skipped.
 */
function liveReport(extra = {}) {
  return { ...overlayReport(), generatedAt: new Date().toISOString(), ...extra };
}

/** Two families, one of them multi-account, plus the tail lines the panel shows. */
function overlayReport() {
  const account = (slot, used) => ({
    family: "opencode-go",
    label: "OpenCode Go (Pi)",
    primaryWindowId: "5h",
    account: slot === 1 ? "" : `#${slot}`,
    plan: "Go plan",
    windows: [
      { id: "5h", label: "5h window", usedPercent: used, remainingPercent: 100 - used, resetsAt: null, resetsInSec: 600, note: null },
      { id: "monthly", label: "Monthly window", usedPercent: 100, remainingPercent: 0, resetsAt: null, resetsInSec: 900000, note: null },
    ],
    error: null,
    ok: true,
    updatedAt: "2030-01-01T00:00:00.000Z",
    expiresInMin: null,
  });
  return {
    generatedAt: "2030-01-01T00:00:00.000Z",
    sources: [],
    warnings: ["one family was throttled"],
    providers: [
      structuredClone(REPORT.providers[0]),
      account(1, 10),
      account(2, 50),
      { ...structuredClone(REPORT.providers[1]), windows: [], error: "no openai-codex credential in the Pi store", ok: false, notConfigured: true },
    ],
  };
}

test("the extension loads and registers /usage", async () => {
  const module = await import(EXTENSION);
  assert.equal(typeof module.default, "function");

  const harness = makeHarness();
  module.default(harness.pi);

  assert.deepEqual(harness.commands.map((command) => command.name), ["usage"]);
  for (const command of harness.commands) {
    assert.equal(typeof command.definition.handler, "function");
    assert.equal(typeof command.definition.description, "string");
  }
  assert.equal(harness.forbidden.length, 0, "extension must not register context-affecting APIs");
});

test("the full panel lists every account while the box and the line keep one per family", async () => {
  const module = await import(EXTENSION);
  /** @param {number} slot @param {number} used */
  const account = (slot, used) => ({
    family: "opencode-go",
    label: "OpenCode Go (Pi)",
    primaryWindowId: "5h",
    account: slot === 1 ? "" : `#${slot}`,
    slot: slot === 1 ? null : String(slot),
    plan: "Go plan",
    windows: [
      { id: "5h", label: "5h window", usedPercent: used, remainingPercent: 100 - used, resetsAt: null, resetsInSec: 600, note: null },
      { id: "monthly", label: "Monthly window", usedPercent: 100, remainingPercent: 0, resetsAt: null, resetsInSec: 900000, note: "rate-limited" },
    ],
    error: null,
    ok: true,
    updatedAt: "2030-01-01T00:00:00.000Z",
    expiresInMin: null,
  });
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [account(1, 10), account(2, 50)],
    },
  });
  module.default(harness.pi);
  await startSession(harness);

  const box = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.equal((box.match(/OP-Go/g) ?? []).length, 1, "the box shows one row per family");

  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);
  const panelWidget = harness.widgets.at(-1);
  const panel = plain(renderWidget(panelWidget).join("\n"));
  assert.match(panel, /OP-Go · 2 of 2 accounts ok/);
  assert.match(panel, /^ +● session +10% \(10m\) +· month 100% \(10d\)/m, "the base entry has no number and still lists every window");
  assert.equal(/#1\b/.test(panel), false, "no surface invents a number for the base entry");
  assert.match(panel, /#2 +● session +50% \(10m\) +· month 100% \(10d\)/);
  assert.equal(/5h window/.test(panel), false, "per-account windows are not listed one per line");
});

test("the panel adds a compact token section per provider and per account", async () => {
  const module = await import(EXTENSION);
  const account = (slot, used) => ({
    family: "opencode-go",
    label: "OpenCode Go (Pi)",
    primaryWindowId: "5h",
    account: slot === 1 ? "" : `#${slot}`,
    slot: slot === 1 ? null : String(slot),
    plan: "Go plan",
    windows: [
      { id: "5h", label: "5h window", usedPercent: used, remainingPercent: 100 - used, resetsAt: null, resetsInSec: 600, note: null },
    ],
    error: null,
    ok: true,
    updatedAt: "2030-01-01T00:00:00.000Z",
    expiresInMin: null,
  });
  const week = [
    { date: "2026-10-27", messageCount: 0 },
    { date: "2026-10-28", messageCount: 10_000 },
    { date: "2026-10-29", messageCount: 0 },
    { date: "2026-10-30", messageCount: 20_000 },
    { date: "2026-10-31", messageCount: 0 },
    { date: "2026-11-01", messageCount: 30_000 },
    { date: "2026-11-02", messageCount: 40_000 },
  ];
  const report = {
    generatedAt: "2030-01-01T00:00:00.000Z",
    sources: [],
    warnings: [],
    providers: [
      {
        family: "claude",
        label: "Claude (Pi)",
        primaryWindowId: "5h",
        account: "fixture@example.com",
        plan: null,
        windows: [
          { id: "5h", label: "5h window", usedPercent: 4, remainingPercent: 96, resetsAt: null, resetsInSec: 3600, note: null },
        ],
        error: null,
        ok: true,
        updatedAt: "2030-01-01T00:00:00.000Z",
        expiresInMin: null,
      },
      account(1, 10),
      account(2, 50),
    ],
    localStats: {
      claude: {
        hasLocalStats: true,
        todayPrompts: 12,
        todaySessions: 2,
        todayTotalTokens: 34_567,
        todayTokensByModel: { "claude-opus-5-5": 34_567 },
        weekTokensByModel: {
          "claude-opus-5-5": 60_000,
          "claude-sonnet-5": 30_000,
          "claude-haiku-4": 8_000,
          "claude-exp-1": 2_000,
        },
        recentDays: week,
        totalPrompts: 99,
        totalSessions: 7,
        activeDays: 4,
        modelUsage: {
          "claude-opus-5-5": { inputTokens: 1_000, outputTokens: 2_000, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 5_000 },
          "claude-sonnet-5": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 0 },
          "claude-haiku-4": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 },
          "claude-exp-1": { inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        },
      },
      "opencode-go": {
        hasLocalStats: true,
        todayPrompts: 5,
        todaySessions: 1,
        todayTotalTokens: 1_250_000,
        weekTokensByModel: { "deepseek-v4.1-flash": 2_000_000 },
        recentDays: week,
        totalPrompts: 50,
        totalSessions: 3,
        activeDays: 4,
        modelUsage: { "deepseek-v4.1-flash": { inputTokens: 1_000_000, outputTokens: 250_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        byAccount: {
          "#1": { todayTokens: 0, weekTokens: 100 },
          "#2": { todayTokens: 1_250_000, weekTokens: 2_000_000 },
        },
      },
    },
    localStatsMeta: { partial: false },
  };
  const harness = makeHarness({ report });
  module.default(harness.pi);
  await startSession(harness);

  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);
  const panel = plain(renderWidget(harness.widgets.at(-1)).join("\n"));

  assert.match(panel, /tokens\s+today 34\.6k · 7d 100k · 12 prompts/);
  assert.match(panel, /claude-opus-5-5 60\.0k · claude-sonnet-5 30\.0k · claude-haiku-4 8\.0k · \+1 more/);
  assert.match(panel, /tokens\s+today 1\.3M · 7d 100k · 5 prompts/);
  assert.match(panel, /deepseek-v4\.1-flash 2\.0M/, "the multi-account family also gets its token section");

  // panelComponent prefixes every line with one space.
  const accountLines = panel.split("\n").filter((line) => /^ +(?:#\d+ +)?[○◔◕●]/.test(line));
  assert.equal(accountLines.length, 2);
  assert.doesNotMatch(accountLines[0], /today/, "an account with no usage today gets no suffix");
  assert.match(accountLines[1], /1\.3M today/, "the account line carries its own tokens");
});

test("a report cached before the label fix still renders the base account without a number", async () => {
  const module = await import(EXTENSION);
  const legacy = (account, slot, today) => ({
    family: "opencode-go",
    label: "OpenCode Go (Pi)",
    account,
    slot,
    plan: "Go plan",
    windows: [{ id: "5h", label: "5h window", usedPercent: 10, remainingPercent: 90, resetsAt: null, resetsInSec: 600, note: null }],
    error: null,
    ok: true,
    updatedAt: "2030-01-01T00:00:00.000Z",
    expiresInMin: null,
  });
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [legacy("#1", null), legacy("#2", "2")],
      localStats: {
        "opencode-go": {
          hasLocalStats: true,
          todayTotalTokens: 500,
          byAccount: { "#1": { todayTokens: 500 }, "#2": { todayTokens: 0 } },
        },
      },
    },
  });
  module.default(harness.pi);
  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);
  const panel = plain(renderWidget(harness.widgets.at(-1)).join("\n"));

  assert.equal(/#1\b/.test(panel), false, "the legacy label is not printed");
  assert.match(panel, /#2/, "a real slot keeps its number");
  assert.match(panel, /500 today/, "the base row still finds its tokens under the old key");
});

test("a partial scan is stated on the panel instead of being passed off as complete", async () => {
  const module = await import(EXTENSION);
  const report = {
    ...REPORT,
    localStats: {
      claude: {
        hasLocalStats: true,
        todayTotalTokens: 500,
        todayPrompts: 1,
        recentDays: [{ date: "2026-11-02", messageCount: 500 }],
        modelUsage: { "claude-opus-5-5": { inputTokens: 500 } },
      },
    },
    localStatsMeta: { partial: true },
  };
  const harness = makeHarness({ report });
  module.default(harness.pi);
  await startSession(harness);

  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);
  const panel = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(panel, /today 500 · 7d 500 · 1 prompt · scan partial/);
});

test("a fourteen-account panel is a component, so Pi's ten-line cap never truncates it", async () => {
  const module = await import(EXTENSION);
  /** @param {number} slot */
  const account = (slot) => {
    const ok = slot <= 7;
    return {
      family: "opencode-go",
      label: "OpenCode Go (Pi)",
      account: `#${slot}`,
      plan: "Go plan",
      windows: ok
        ? [
            { id: "5h", label: "5h window", usedPercent: 0, remainingPercent: 100, resetsAt: null, resetsInSec: 600, note: null },
            { id: "monthly", label: "Monthly window", usedPercent: 10 + slot * 10, remainingPercent: 90 - slot * 10, resetsAt: null, resetsInSec: 900000, note: null },
          ]
        : [],
      error: ok ? null : slot <= 10 ? "OpenCode Go key rejected (401); reconnect that account in Pi" : "Go plan not active for this workspace (403 Workspace access denied)",
      ok,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: null,
    };
  };
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [structuredClone(REPORT.providers[0]), ...Array.from({ length: 14 }, (_, index) => account(index + 1))],
    },
  });
  module.default(harness.pi);
  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);

  const widget = harness.widgets.at(-1);
  assert.equal(typeof widget, "function", "a string array would be capped at ten lines by Pi");
  const lines = renderWidget(widget, undefined, 40);
  assert.ok(lines.length > 15, `every account has its own line (${lines.length})`);
  assert.ok(lines.every((line) => plain(line).length <= 40), "no line is wider than the widget");
  const panel = plain(renderWidget(widget).join("\n"));
  assert.match(panel, /OP-Go · 7 of 14 accounts ok/);
  assert.match(panel, /#14 .*no Go plan/);
  assert.match(panel, /#8 .*key rejected/);
  assert.match(panel, /#7 .*session +0% .*month +80%/);
});

test("bare /usage opens a fullscreen overlay, refreshes behind it and leaves the editor clean", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  harness.widgets.length = 0;

  const overlays = installOverlay(harness);
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  assert.equal(overlays.length, 1, "bare /usage opens one focused view");
  assert.deepEqual(overlays[0].options, {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
  }, "the view is the same fullscreen overlay pi-context-view uses");
  await settle();

  const frame = frameText(overlays[0], 90);
  assert.match(frame, /Quota/, "the view has a title row");
  assert.match(frame, /❯ ▾ Claude/, "the cursor starts on the first section header");
  assert.match(frame, /5h window/);
  assert.match(frame, /Weekly window/);
  assert.match(frame, /▾ OP-Go · 2 of 2 accounts ok/);
  assert.match(frame, /\s+●\s+session/, "the base account row carries no invented number");
  assert.equal(/#1\b/.test(frame), false, "the base entry has no number in any surface");
  assert.match(frame, /#2\s+●\s+session/);
  assert.match(frame, /used % · read-only/, "the panel footer is part of the view");
  assert.equal(frame.split("\n").filter((line) => /2030-01-01T00:00:00\.000Z/.test(line)).length, 0, "the footer does not repeat the timestamp the header already prints");
  assert.match(frame.split("\n")[0], /updated \d\d:\d\d/, "the header is the one place the update time appears");
  assert.match(frame, /warn: one family was throttled/);
  assert.match(frame, /↑↓\/jk move/, "the legend lists the move keys");
  assert.match(frame, /enter\/space\/←→\/hl fold/, "…the fold keys");
  assert.match(frame, /pgup\/pgdn page/, "…paging");
  assert.match(frame, /g\/G home\/end top\/end/, "…the jumps");
  assert.match(frame, /wheel scroll/, "…the wheel");
  assert.match(frame, /r refresh/, "…refresh");
  assert.match(frame, /esc\/q close/, "…and every close key");
  assert.equal(harness.widgets.length, 0, "bare /usage pins nothing above the editor");

  overlays[0].component.handleInput("\u001b");
  await pending;
  assert.equal(overlays[0].doneCalls, 1, "Esc closes the view");
  assert.equal(harness.widgets.length, 0, "nothing is left on screen after Esc");
});

test("the overlay folds the section under the cursor with enter, space, h/l and the arrow keys", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness);
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  const overlay = overlays[0];
  const frame = () => frameText(overlay);

  assert.match(frame(), /5h window/, "every section starts expanded");

  overlay.component.handleInput("\r");
  assert.match(frame(), /❯ ▸ Claude/, "Enter folds the section under the cursor");
  assert.equal(/5h window/.test(frame()), false, "a folded section hides its windows");

  overlay.component.handleInput(" ");
  assert.match(frame(), /❯ ▾ Claude/, "Space unfolds it again");
  assert.match(frame(), /5h window/);

  overlay.component.handleInput("\u001b[D");
  assert.equal(/5h window/.test(frame()), false, "left collapses");
  overlay.component.handleInput("\u001b[C");
  assert.match(frame(), /5h window/, "right expands");

  overlay.component.handleInput("j");
  assert.match(frame(), /❯ ▾ OP-Go/, "j moves the cursor to the next header");
  overlay.component.handleInput("h");
  assert.match(frame(), /❯ ▸ OP-Go/);
  assert.equal(/#2\s+●/.test(frame()), false, "fold state is per section");
  overlay.component.handleInput("l");
  assert.match(frame(), /#2\s+●/);
  assert.match(frame(), /▾ Claude/, "the other section kept its own fold state");

  overlay.component.handleInput("\u001b");
  await pending;
});

test("a host without custom components keeps the pinned panel instead of failing", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness, null);
  harness.widgets.length = 0;

  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("", harness.ctx);

  assert.equal(typeof harness.widgets.at(-1), "function", "the fallback is the old pinned panel");
  assert.match(plain(renderWidget(harness.widgets.at(-1)).join("\n")), /used % · read-only/);
  assert.match(harness.notifications.at(-1), /no fullscreen overlay/);
});

test("no surface is pinned at session start and the footer is left alone", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness, null);

  assert.equal(harness.widgets.at(-1), undefined, "nothing is pinned above the editor by default");
  assert.equal(harness.statuses.at(-1), undefined, "the footer must stay untouched by default");

  const usage = harness.commands.find((command) => command.name === "usage");
  assert.deepEqual(
    usage.definition.getArgumentCompletions("").map((completion) => completion.value),
    ["refresh", "line", "box", "panel", "hide", "status", "nostatus", "json"],
    "every surface stays one subcommand away",
  );
});

test("the boxed widget remains when sidebar symbols are present but inactive", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);

  const tui = {
    terminal: {
      [Symbol.for("gentle-pi.experimental-sidebar.state")]: { active: false, ownsHost: () => true, parts: new Map() },
      [Symbol.for("gentle-pi.experimental-sidebar.cache")]: { revision: 0 },
    },
  };
  const lines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, tui);
  assert.match(plain(lines.join("\n")), /Claude:\s+○\s+4%/);
});

test("a patched active rail registers quota natively and suppresses the above-editor widget", async () => {
  await withRailFixtures(async ({ layoutPath }) => {
    const originalLayout = readFileSync(layoutPath, "utf-8");
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    assert.equal(readFileSync(layoutPath, "utf-8"), originalLayout, "startup must leave the installed layout unchanged");

    const state = { active: true, ownsHost: () => true, parts: new Map() };
    const lines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, { terminal: { [SIDEBAR_STATE]: state } });
    assert.deepEqual(lines, [], "the rail is painting the card, so the box must not duplicate it");
    assert.ok(state.parts.get("quota"), "the rail part must be registered under the patched key");
  }, { patched: true });
});

test("todo rail mounting suppresses the above-editor widget without ownsHost", async () => {
  await withRailFixtures(async () => {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const widget = harness.widgets.at(-1);
    const state = { active: false, parts: new Map([["todo", {}]]) };
    const tui = { terminal: { [SIDEBAR_STATE]: state } };
    const mountedWidget = widget(tui, harness.ctx.ui.theme);

    tui.terminal[SIDEBAR_STATE] = { active: true, ownsHost: () => false, parts: new Map([["todo", {}]]) };
    assert.deepEqual(mountedWidget.render(100), [], "a live active rail suppresses the duplicate even when ownsHost() is false");

    for (const activeState of [
      { active: true, parts: new Map([["todo", {}]]) },
      { active: false, parts: new Map([["todo", {}]]) },
    ]) {
      const activeTui = { terminal: { [SIDEBAR_STATE]: activeState } };
      const activeWidget = widget(activeTui, harness.ctx.ui.theme);
      if (!activeState.active) {
        activeTui.mode = "fullscreen";
        activeTui.terminal.columns = 140;
      }
      assert.deepEqual(activeWidget.render(100), [], "active state or a wide fullscreen rail suppresses the box");
    }
  });
});

test("an inactive patched rail keeps opt into the box and then the compact line", async () => {
  await withRailFixtures(async () => {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const state = { active: false, ownsHost: () => true, parts: new Map() };
    const tui = { terminal: { [SIDEBAR_STATE]: state } };
    const defaultLines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, tui);
    assert.equal(defaultLines.length, 7, "the box remains the default when the rail is inactive");

    const usage = harness.commands.find((command) => command.name === "usage");
    await usage.definition.handler("line", harness.ctx);
    const lines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, tui);
    assert.equal(lines.length, 1, "explicit /usage line opts into the compact surface");
    assert.match(plain(lines[0]), /Claude:○\s+4%/);
  }, { patched: true });
});

test("an unpatched active rail uses the runtime hook without changing gentle-pi files", async () => {
  await withRailFixtures(async ({ layoutPath }) => {
    const originalLayout = readFileSync(layoutPath, "utf-8");
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const originalFooter = {
      digest: () => "footer",
      render: (width) => [`footer ${width}`],
    };
    const state = { active: true, ownsHost: () => true, parts: new Map([["footer", originalFooter]]) };
    const tui = { terminal: { [SIDEBAR_STATE]: state } };
    const widget = harness.widgets.at(-1)(tui, harness.ctx.ui.theme);

    assert.deepEqual(widget.render(100), [], "the active rail owns the quota surface");
    assert.equal(readFileSync(layoutPath, "utf-8"), originalLayout, "an unpatched layout stays byte-for-byte pristine");
    assert.equal(existsSync(`${layoutPath}.pi-quota-backup`), false, "startup creates no patch backup");
    assert.equal(originalLayout, STOCK_RAIL);
    assert.equal(harness.notifications.some((message) => /restart/i.test(message)), false, "runtime fallback needs no restart warning");
    const chainedFooter = state.parts.get("footer");
    assert.notEqual(chainedFooter, originalFooter);
    assert.ok(state.parts.has("quota"), "the runtime quota part remains registered");
    const railLines = chainedFooter.render(40);
    assert.equal(railLines[0], "footer 40");
    assert.match(plain(railLines.join("\n")), /Quota/);
    assert.match(plain(railLines.join("\n")), /Claude:/);

    widget.dispose();
    assert.equal(state.parts.get("footer"), originalFooter, "disposal restores the original footer component");
    assert.equal(state.parts.has("quota"), false, "disposal removes the quota rail part");
  });
});

test("a gentle-pi update that removes the rail slot stays untouched and needs no restart warning", async () => {
  await withRailFixtures(async ({ layoutPath }) => {
    const module = await import(EXTENSION);
    const first = makeHarness();
    module.default(first.pi);
    await startSession(first);
    assert.equal(readFileSync(layoutPath, "utf-8"), PATCHED_RAIL, "startup leaves the native rail layout unchanged");

    writeFileSync(layoutPath, STOCK_RAIL, "utf-8");

    const second = makeHarness();
    module.default(second.pi);
    await startSession(second);
    assert.equal(readFileSync(layoutPath, "utf-8"), STOCK_RAIL, "a package update remains unmodified");
    assert.equal(second.notifications.some((message) => /restart/i.test(message)), false, "the runtime fallback does not ask for a restart");
  }, { patched: true });
});

test("the line shows used percent, not remaining", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);

  const visible = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  // Claude 5h is 96% left => 4% used; Antigravity's shortest window is 62% used.
  assert.match(visible, /Claude:\s+○\s+4%/);
  assert.match(visible, /Codex:\s+○\s+19%/);
  assert.match(visible, /Agy:\s+◕\s+62%/);
  assert.match(visible, /OP-Go:\s+!/);
  assert.equal(/left/.test(visible), false, "must not report remaining");
});

test("each provider name is painted with its own brand colour", async () => {
  const prevTerm = process.env.TERM;
  const prevNoColor = process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  try {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const raw = String(renderWidget(harness.widgets.at(-1)).join("\n"));
    assert.match(raw, /\u001b\[38;2;217;119;87m/, "Claude clay");
    assert.match(raw, /\u001b\[38;2;16;163;127m/, "Codex teal");
    assert.match(raw, /\u001b\[38;2;66;133;244m/, "Google blue");
  } finally {
    process.env.TERM = prevTerm;
    if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("the semaphore changes colour and shape with the used band", async () => {
  const prevTerm = process.env.TERM;
  const prevNoColor = process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  try {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);
    const raw = String(renderWidget(harness.widgets.at(-1)).join("\n"));

    assert.ok(raw.includes("#3FB950") === false);
    assert.match(raw, /\u001b\[38;2;63;185;80m○/, "green empty circle for low usage");
    assert.match(raw, /\u001b\[38;2;210;153;34m◕/, "amber half circle for mid usage");
  } finally {
    process.env.TERM = prevTerm;
    if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("NO_COLOR is honoured so a mono terminal stays readable", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    await startSession(harness);
    const raw = String(renderWidget(harness.widgets.at(-1)).join("\n"));
    assert.equal(/\u001b\[38;2;/.test(raw), false, "no truecolor when NO_COLOR is set");
    assert.match(raw, /Claude:\s+○\s+4%/);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

/** One `piquota stats --json` payload, as the CLI emits it. */
function historyPayload(month, months, { days = {}, totals = null, notes = [], quarantined = [] } = {}) {
  return {
    schemaVersion: 1,
    historyDir: "/tmp/pi-usage",
    generatedAt: "2030-01-01T00:00:00.000Z",
    months,
    quarantined,
    month,
    days,
    totals,
    notes,
  };
}

const HISTORY_TOTALS = {
  lastFrozenDay: "2026-10-02",
  families: {
    claude: {
      firstDay: "2026-10-01",
      activeDates: ["2026-10-01", "2026-10-02"],
      totalPrompts: 6,
      totalSessions: 2,
      modelUsage: {
        "claude-opus-5-5": { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 },
      },
      accounts: {
        "": { totalPrompts: 6, totalSessions: 2, modelUsage: { "claude-opus-5-5": { input: 2_000 } } },
      },
    },
    "opencode-go": {
      firstDay: "2026-10-01",
      activeDates: ["2026-10-01"],
      totalPrompts: 6,
      totalSessions: 1,
      modelUsage: { "deepseek-v4.1-flash": { input: 3_000 } },
      accounts: {
        "": { totalPrompts: 2, totalSessions: 1, modelUsage: { "deepseek-v4.1-flash": { input: 1_000 } } },
        "#2": { totalPrompts: 4, totalSessions: 1, modelUsage: { "deepseek-v4.1-flash": { input: 2_000 } } },
      },
    },
  },
};

const HISTORY_OCTOBER = {
  "2026-10-01": {
    claude: {
      sessions: 2,
      tokens: 1_200,
      prompts: 4,
      slots: {
        "": { sessions: 2, tokens: 1_200, prompts: 4, models: { "claude-opus-5-5": { tokens: 1_000, messages: 4 }, "claude-sonnet-5": { tokens: 200, messages: 0 } } },
      },
    },
    "opencode-go": {
      sessions: 1,
      tokens: 3_000,
      prompts: 6,
      slots: {
        "": { sessions: 1, tokens: 1_000, prompts: 2, models: { "deepseek-v4.1-flash": { tokens: 1_000, messages: 2 } } },
        "2": { sessions: 1, tokens: 2_000, prompts: 4, models: { "deepseek-v4.1-flash": { tokens: 2_000, messages: 4 } } },
      },
    },
  },
  "2026-10-02": {
    claude: { sessions: 0, tokens: 800, prompts: 2, slots: { "": { tokens: 800, prompts: 2, models: { "claude-opus-5-5": { tokens: 800, messages: 2 } } } } },
  },
};

/** A history payload for the current local month, with one frozen day. */
function currentMonthHistory(todayKey, month, extraDays = {}) {
  return historyPayload(month, ["2026-09", month], {
    days: {
      ...extraDays,
      [`${month}-01`]: {
        claude: { tokens: 400, prompts: 1, slots: { "": { tokens: 400, prompts: 1, models: { "claude-opus-5-5": { tokens: 400, messages: 1 } } } } },
      },
    },
    totals: { lastFrozenDay: `${month}-01`, families: { claude: { totalPrompts: 1, modelUsage: { "claude-opus-5-5": { input: 400 } }, accounts: { "": { modelUsage: { "claude-opus-5-5": { input: 400 } } } } } } },
  });
}

/** Route `pi.exec`: `stats --json` answers from the fixtures, the report path stays. */
function routeHistory(harness, months, byMonth) {
  const calls = [];
  const exec = harness.pi.exec;
  harness.pi.exec = async (runner, argv, options) => {
    if (argv.includes("stats")) {
      const index = argv.indexOf("--month");
      const requested = index === -1 ? null : argv[index + 1];
      const month = requested ?? months[months.length - 1];
      calls.push(requested);
      const payload = byMonth[month] ?? historyPayload(month, months, { notes: [`no frozen days for ${month} in /tmp/pi-usage`] });
      return { stdout: JSON.stringify(payload), stderr: "", code: 0 };
    }
    return exec(runner, argv, options);
  };
  return calls;
}

/**
 * Route `stats --json` to promises the test settles in whatever order it likes:
 * overlapping ←/→ presses are the point, and their answers arrive out of order.
 */
function routeHistoryDeferred(harness) {
  const waiting = new Map();
  const calls = [];
  const exec = harness.pi.exec;
  harness.pi.exec = async (runner, argv, options) => {
    if (!argv.includes("stats")) return exec(runner, argv, options);
    const index = argv.indexOf("--month");
    const month = index === -1 ? null : argv[index + 1];
    calls.push(month);
    return new Promise((resolve) => waiting.set(month, resolve));
  };
  const settle = (month, result) => {
    const resolve = waiting.get(month);
    assert.ok(resolve, `no stats request is waiting for ${month}`);
    waiting.delete(month);
    resolve(result);
  };
  const answer = (month, payload) => settle(month, { stdout: JSON.stringify(payload), stderr: "", code: 0 });
  const fail = (month, stderr = "stats: another piquota run holds the history lock") =>
    settle(month, { stdout: "", stderr: `${stderr}\n`, code: 1 });
  return { calls, answer, fail };
}

/** A provider with enough windows to be taller than a short overlay viewport. */
function tallProvider(count = 14) {
  return {
    ...structuredClone(REPORT.providers[0]),
    windows: Array.from({ length: count }, (_, index) => ({
      id: index === 0 ? "5h" : `w${index}`,
      label: `window ${index + 1}`,
      usedPercent: index * 5,
      remainingPercent: 100 - index * 5,
      resetsAt: null,
      resetsInSec: 3600 + index,
      note: null,
    })),
  };
}

function tallOverlayReport(count = 14) {
  return {
    generatedAt: "2030-01-01T00:00:00.000Z",
    sources: [],
    warnings: [],
    providers: [tallProvider(count), { ...structuredClone(REPORT.providers[1]), account: "codex@example.com" }],
  };
}

test("the overlay walks headers, scrolling a tall open section before it jumps", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: tallOverlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 12 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  const overlay = overlays[0];
  const frame = () => frameText(overlay);
  const firstRow = () => frame().split("\n")[2];

  assert.equal(overlay.component.render(90).length, 12, "the overlay owns the whole terminal height");
  assert.match(firstRow(), /❯ ▾ Claude/);

  overlay.component.handleInput("j");
  assert.equal(/▾ Claude/.test(frame()), false, "a section taller than the viewport scrolls one line first");
  assert.match(frame(), /window 1 .*0\.0%/, "…so its body moves before the cursor can move on");

  for (let step = 0; step < 20; step += 1) overlay.component.handleInput("j");
  assert.match(frame(), /❯ ▾ Codex/, "past the section the cursor reaches the next header");

  overlay.component.handleInput("k");
  assert.match(frame(), /❯ ▾ Claude/);
  for (let step = 0; step < 20; step += 1) overlay.component.handleInput("k");
  assert.match(firstRow(), /❯ ▾ Claude/, "k at the first header scrolls back to the top and stops");

  overlay.component.handleInput("G");
  assert.match(frame(), /❯ ▾ Codex/, "End/G picks the last header");
  assert.match(frame(), /used % · read-only/, "…and scrolls to the bottom of the view");
  overlay.component.handleInput("g");
  assert.match(firstRow(), /❯ ▾ Claude/, "Home/g returns to the top");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("the overlay pages, jumps and scrolls with the wheel, and ignores other mouse events", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: tallOverlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 12 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  const overlay = overlays[0];
  const frame = () => frameText(overlay);

  assert.match(frame(), /1-7\/\d+/, "the status row reports the visible range");

  overlay.component.handleInput("\u001b[6~");
  assert.match(frame(), /8-14\/\d+/, "PgDn scrolls one page");
  overlay.component.handleInput("\u001b[5~");
  assert.match(frame(), /1-7\/\d+/, "PgUp scrolls back");

  assert.equal(overlay.component.handleMouse({ type: "mousedown", wheelDelta: 3 }), undefined, "only wheel events are handled");
  assert.equal(overlay.component.handleMouse({ type: "wheel", wheelDelta: 0 }), undefined, "a zero notch is not a scroll");
  assert.deepEqual(overlay.component.handleMouse({ type: "wheel", wheelDelta: 3 }), { handled: true, render: true });
  assert.match(frame(), /4-10\/\d+/, "the wheel scrolls by its delta");
  overlay.component.handleMouse({ type: "wheel", wheelDelta: -100 });
  assert.match(frame(), /1-7\/\d+/, "the wheel clamps at the top");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("r refreshes from inside the overlay and never closes it", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  const calls = [];
  const exec = harness.pi.exec;
  harness.pi.exec = async (...args) => {
    calls.push(args);
    return exec(...args);
  };
  module.default(harness.pi);
  await startSession(harness, null);

  const overlays = installOverlay(harness);
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  assert.ok(calls.some(([, argv]) => argv.includes("--force")), "bare /usage forces one refresh on open");

  const baseline = calls.length;
  overlays[0].component.handleInput("r");
  await settle();
  const forced = calls.slice(baseline).filter(([, argv]) => argv.includes("--force"));
  assert.equal(forced.length, 1, "r runs another forced refresh");
  assert.equal(overlays[0].doneCalls, 0, "r leaves the view open");

  // On History, r reloads the month AND the report its today row depends on.
  overlays[0].component.handleInput("2");
  await settle();
  const onHistory = calls.length;
  overlays[0].component.handleInput("r");
  await settle();
  const after = calls.slice(onHistory);
  assert.equal(after.filter(([, argv]) => argv.includes("--force")).length, 1, "r on History forces a report refresh");
  assert.ok(after.some(([, argv]) => argv.includes("stats")), "r on History reloads the month");
  assert.match(frameText(overlays[0]).split("\n")[0], /updated \d\d:\d\d/, "History's header shows when the report it merges was updated");

  overlays[0].component.handleInput("q");
  await pending;
  assert.equal(overlays[0].doneCalls, 1, "q closes the view too");
});

test("the overlay fits 64 columns and rebuilds the frame after a resize", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 30 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  const overlay = overlays[0];

  const wide = overlay.component.render(90);
  const narrow = overlay.component.render(64);
  assert.notEqual(narrow, wide, "a width change invalidates the cached frame");
  assert.equal(narrow.length, 30, "the frame always fills the terminal height");
  assert.ok(narrow.every((line) => plain(line).length <= 64), "no line is wider than the terminal");

  const tiny = overlay.component.render(40);
  assert.ok(tiny.every((line) => plain(line).length <= 40));
  const legend = plain(tiny.slice(-4).join("\n"));
  for (const keys of ["↑↓/jk", "enter/space/←→/hl", "pgup/pgdn", "g/G", "wheel", "r refresh", "esc/q"]) {
    assert.ok(legend.includes(keys), `a narrow pane wraps the legend instead of dropping "${keys}"`);
  }

  overlay.tui.terminal.rows = 20;
  const short = overlay.component.render(64);
  assert.equal(short.length, 20, "a height change rebuilds the frame for the new terminal");

  overlay.component.handleInput("\u001b");
  await pending;
});

test("a row wider than the pane wraps at its separators instead of losing its tail", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: wideReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  const overlay = overlays[0];

  const rendered = overlay.component.render(64);
  assert.ok(rendered.every((line) => plain(line).length <= 64), "no line is wider than the terminal");
  const frame = plain(rendered.join("\n"));
  // The datum the old hard clip cut off: when the month resets.
  assert.match(frame, /month\s+100% \(18d\)/, "the month reset survives the wrap");
  assert.match(frame, /session\s+0% \(5h\)/, "…and the session reset on the row above it");
  assert.match(frame, /week\s+0% \(5d\)/, "…and the weekly one");
  assert.equal(/\u2026/.test(frame), false, "nothing is elided: the row wraps, it does not clip");
  // A warning in the tail has no " · " separators, so it wraps between words.
  const rejoined = frame.split("\n").map((line) => line.trim()).join(" ");
  assert.match(
    rejoined,
    /the upstream probe fell back to a cached observation while the token expires in 3 minutes/,
    "a long warning wraps between words and loses nothing",
  );

  // The same rows must survive the pinned panel, which clips at width - 1.
  await usage.definition.handler("panel", harness.ctx);
  const panel = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 64).map(plain);
  assert.ok(panel.every((line) => line.length <= 64), "the pinned panel wraps too");
  assert.match(panel.join("\n"), /month\s+100% \(18d\)/);

  overlay.component.handleInput("\u001b");
  await pending;
});

test("paging a page that cannot scroll leaves the selection where it was", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  const overlay = overlays[0];
  assert.match(frameText(overlay), /❯ ▾ Claude/, "the cursor starts on the first header");

  // Every row fits, so PgUp/PgDn cannot scroll. They used to re-snap the cursor
  // to the last visible header, moving the selection *down* on PgUp.
  overlay.component.handleInput("\u001b[5~");
  assert.match(frameText(overlay), /❯ ▾ Claude/, "PgUp on a page that cannot scroll does not move the cursor");
  overlay.component.handleInput("\u001b[6~");
  assert.match(frameText(overlay), /❯ ▾ Claude/, "…and neither does PgDn");
  overlay.component.handleInput("j");
  assert.match(frameText(overlay), /❯ ▾ OP-Go/, "the cursor still walks with j");

  overlay.component.handleInput("\u001b");
  await pending;
});

test("the legend balances its rows instead of orphaning the close key", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();

  const legend = legendRows(plain(overlays[0].component.render(120).join("\n")));
  assert.equal(legend.length, 2, `the legend needs two rows at 120 columns: ${JSON.stringify(legend)}`);
  for (const row of legend) {
    assert.ok((row.match(/ · /g) ?? []).length >= 2, `every row carries a fair share of the pairs: ${JSON.stringify(row)}`);
  }
  assert.equal(legend.some((row) => /^\s*esc\/q close\s*$/.test(row)), false, "the close key is never alone on a row");
  assert.match(legend.join(" "), /esc\/q close/, "…and it is still listed");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("the header shows a refresh indicator, then the time the update landed", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness);
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);

  assert.match(frameText(overlays[0]).split("\n")[0], /refreshing …/, "the refresh is visible while it runs");
  await settle();
  assert.match(frameText(overlays[0]).split("\n")[0], /updated \d\d:\d\d/, "the update time replaces it");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("bare /usage paints the cached report on the first frame without waiting for the CLI", async () => {
  const module = await import(EXTENSION);
  const cacheHome = mkdtempSync(join(tmpdir(), "pi-quota-overlay-cache-"));
  mkdirSync(join(cacheHome, "pi-quota"), { recursive: true });
  const cachePath = join(cacheHome, "pi-quota", "usage.json");
  writeFileSync(cachePath, JSON.stringify({
    savedAt: Date.now(),
    key: "fixture",
    report: withFamilies(overlayReport()),
  }), "utf-8");
  const cachedBefore = readFileSync(cachePath, "utf-8");
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  try {
    const harness = makeHarness({ report: overlayReport() });
    let release;
    harness.pi.exec = () => new Promise((resolve) => {
      release = () => resolve({ stdout: JSON.stringify(withFamilies(overlayReport())), stderr: "", code: 0 });
    });
    module.default(harness.pi);
    await startSession(harness, null);
    const overlays = installOverlay(harness);
    const usage = harness.commands.find((command) => command.name === "usage");
    const pending = usage.definition.handler("", harness.ctx);

    const first = frameText(overlays[0]);
    assert.match(first, /▾ Claude/, "the cached report is painted immediately");
    assert.match(first, /5h window/, "…with its windows, not a placeholder");
    assert.doesNotMatch(first, /loading quota/, "the CLI is not awaited before the first frame");
    assert.match(first.split("\n")[0], /refreshing …/, "the background refresh is still announced");

    release();
    await settle();
    assert.match(frameText(overlays[0]).split("\n")[0], /updated \d\d:\d\d/);
    assert.equal(readFileSync(cachePath, "utf-8"), cachedBefore, "the cache is only read, never rewritten");

    overlays[0].component.handleInput("\u001b");
    await pending;
  } finally {
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
  }
});

test("the overlay opens on a loading line and shows a refresh failure in place", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ fail: true });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness);
  harness.widgets.length = 0;

  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  assert.match(frameText(overlays[0]), /loading quota …/, "the first frame renders before the report lands");
  await settle();
  assert.match(frameText(overlays[0]), /! piquota exploded/, "a failed refresh is a line, not a throw");
  assert.match(frameText(overlays[0]), /refresh failed/);
  assert.equal(harness.widgets.length, 0, "a failed bare /usage still paints no widget");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("the omarchy publish after a refresh never shows up as a quota failure", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  const exec = harness.pi.exec;
  harness.pi.exec = async (runner, argv, options) => {
    // The real `piquota omarchy` writes human text, not JSON.
    if (argv.includes("omarchy")) return { stdout: "omarchy: wrote 3 records\n", stderr: "", code: 0 };
    return exec(runner, argv, options);
  };
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness);
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();

  const frame = frameText(overlays[0]);
  assert.doesNotMatch(frame, /refresh failed/, "the advisory publish is not a quota refresh");
  assert.doesNotMatch(frame, /not valid JSON/);
  assert.match(frame, /▾ Claude/, "the real report still landed");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("subcommands toggle the line, the panel, the footer and hide everything", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  const usage = harness.commands.find((command) => command.name === "usage");

  await usage.definition.handler("panel", harness.ctx);
  assert.ok(renderWidget(harness.widgets.at(-1)).length > 1);

  await usage.definition.handler("line", harness.ctx);
  assert.equal(renderWidget(harness.widgets.at(-1)).length, 1);

  await usage.definition.handler("box", harness.ctx);
  assert.equal(renderWidget(harness.widgets.at(-1)).length, 7);

  await usage.definition.handler("status", harness.ctx);
  assert.match(plain(harness.statuses.at(-1)), /Claude:○ 4%/);

  await usage.definition.handler("nostatus", harness.ctx);
  assert.equal(harness.statuses.at(-1), undefined);

  await usage.definition.handler("hide", harness.ctx);
  assert.equal(harness.widgets.at(-1), undefined);
});

test("a failing CLI reports an error instead of throwing", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ fail: true });
  module.default(harness.pi);
  await startSession(harness);

  assert.match(plain(renderWidget(harness.widgets.at(-1)).join("\n")), /quota …/);

  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("refresh", harness.ctx);
  assert.ok(harness.notifications.some((message) => message.startsWith("Quota refresh failed: piquota exploded")));
});

test("session_shutdown clears both the footer and the widget", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);
  await harness.handlers.get("session_shutdown")({}, harness.ctx);

  assert.equal(harness.statuses.at(-1), undefined);
  assert.equal(harness.widgets.at(-1), undefined);
});

test("the line stays compact enough to fit one row", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);

  const visible = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.ok(visible.split("\n").every((line) => line.length <= 100), `box too wide: ${visible}`);
});

test("the panel is only painted after /usage asks for it", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness, null);

  assert.equal(harness.widgets.at(-1), undefined, "session start paints no surface");

  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);
  const panel = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(panel, /Claude/);
  assert.match(panel, /5h window/, "the panel shows the fetched windows, not a loading placeholder");
});

test("unconfigured providers are omitted from the editor line and summary", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: ["/tmp/auth.json"],
      warnings: [],
      providers: [
        {
          family: "claude",
          label: "Claude (Pi)",
          primaryWindowId: "5h",
          account: "fixture@example.com",
          plan: null,
          windows: [{ id: "5h", label: "5h", usedPercent: 10, remainingPercent: 90, resetsAt: null, resetsInSec: 3600, note: null }],
          error: null,
          ok: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: 60,
        },
        {
          family: "codex",
          label: "Codex (Pi)",
          primaryWindowId: "5h",
          account: "fixture@example.com",
          plan: "plus",
          windows: [{ id: "5h", label: "5h", usedPercent: 5, remainingPercent: 95, resetsAt: null, resetsInSec: 3600, note: null }],
          error: null,
          ok: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: 60,
        },
        {
          family: "antigravity",
          label: "Antigravity (Pi)",
          primaryWindowId: null,
          account: "unknown",
          plan: null,
          windows: [],
          error: "no antigravity credential in the Pi store",
          ok: false,
          notConfigured: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: null,
        },
        {
          family: "opencode-go",
          label: "OpenCode Go (Pi)",
          primaryWindowId: null,
          account: "unknown",
          plan: null,
          windows: [],
          error: "no opencode-go credential in the Pi store",
          ok: false,
          notConfigured: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: null,
        },
      ],
    },
  });
  module.default(harness.pi);
  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("line", harness.ctx);

  const visible = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  // When only Claude and Codex are in auth.json, only those two appear!
  assert.match(visible, /Claude:\s*○\s+10%/);
  assert.match(visible, /Codex:\s*○\s+5%/);
  assert.equal(visible.includes("Agy"), false, "unconfigured Antigravity must not appear in the line");
  assert.equal(visible.includes("OP-Go"), false, "unconfigured OpenCode Go must not appear in the line");
});

test("renderLine distinguishes transient / throttle / expired / auth with category-specific glyphs", async () => {
  const module = await import(EXTENSION);
  const providers = [
    ["transient", "HTTP 503 upstream"],
    ["throttle", "HTTP 429 rate limited"],
    ["expired", "token expired"],
    ["auth", "HTTP 401 unauthorized"],
  ].map(([family, error]) => ({
    family,
    label: family,
    primaryWindowId: null,
    account: "fixture@example.com",
    plan: null,
    windows: [],
    error,
    ok: false,
    updatedAt: "2030-01-01T00:00:00.000Z",
    expiresInMin: null,
  }));
  const harness = makeHarness({
    report: { generatedAt: "2030-01-01T00:00:00.000Z", sources: [], warnings: [], providers },
    theme: { fg: (key, text) => `[${key}:${text}]`, bold: (text) => text },
  });
  module.default(harness.pi);
  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("line", harness.ctx);

  const line = plain(renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme).join("\n"));
  assert.match(line, /transient:\[warning:~\]/);
  assert.match(line, /throttle:\[warning:…\]/);
  assert.match(line, /expired:\[error:!\]/);
  assert.match(line, /auth:\[error:!\]/);
});

test("renderLine excludes notConfigured providers using the flag, not the error string", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [
        {
          family: "codex", label: "Codex", primaryWindowId: null, account: "fixture@example.com", plan: null, windows: [],
          error: "no credential in the Pi store", ok: false, updatedAt: "2030-01-01T00:00:00.000Z", expiresInMin: null,
        },
        {
          family: "claude", label: "Claude", primaryWindowId: null, account: "unknown", plan: null, windows: [],
          error: "token expired", ok: false, notConfigured: true, updatedAt: "2030-01-01T00:00:00.000Z", expiresInMin: null,
        },
      ],
    },
  });
  module.default(harness.pi);
  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("line", harness.ctx);

  const line = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(line, /Codex:\?/);
  assert.equal(line.includes("Claude"), false);
});

test("when mergeLastGood restores a transient failure, the line paints the carried value and not !", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-quota-extension-")), "last-good.json");
  const good = structuredClone(REPORT.providers[0]);
  const initial = withFamilies({ generatedAt: "2030-01-01T00:00:00.000Z", sources: [], warnings: [], providers: [good] });
  mergeLastGood(initial, { path, now: 1_000 });
  const failed = withFamilies({
    generatedAt: "2030-01-01T00:01:00.000Z",
    sources: [],
    warnings: [],
    providers: [{ ...good, windows: [], error: "request timed out", ok: false, note: null }],
  });
  const merged = mergeLastGood(failed, { path, now: 61_000 }).report;
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: merged });
  module.default(harness.pi);
  await startSession(harness);

  const line = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(line, /Claude:\s+○\s+4%/);
  assert.equal(line.includes("Claude:!"), false);
  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);
  assert.match(plain(renderWidget(harness.widgets.at(-1)).join("\n")), /last known values, 1 min old/);
});

test("renderPanel footer lists notConfigured providers using the flag", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [
        { ...structuredClone(REPORT.providers[0]), error: "no credential in the Pi store", ok: false, windows: [] },
        { ...structuredClone(REPORT.providers[1]), error: "token expired", ok: false, windows: [], notConfigured: true },
      ],
    },
  });
  module.default(harness.pi);
  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);

  const panel = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(panel, /Codex/);
  assert.match(panel, /not configured in Pi: Codex/);
  assert.equal(/not configured in Pi: Claude/.test(panel), false);
});

test("the panel names the Claude store, and the line never does", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: ["/tmp/auth.json"],
      warnings: [],
      providers: [
        {
          family: "claude",
          label: "Claude (Pi)",
          primaryWindowId: "5h",
          account: "fixture@example.com",
          plan: "pro",
          sourceKind: "claude-code",
          windows: [{ id: "5h", label: "5h", usedPercent: 10, remainingPercent: 90, resetsAt: null, resetsInSec: 3600, note: null }],
          error: null,
          ok: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: 60,
        },
      ],
    },
  });
  module.default(harness.pi);
  await startSession(harness);

  const line = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.equal(/Claude Code CLI/.test(line), false, "the compact widget must stay short");
  assert.match(line, /Claude:\s+○\s+10%/);

  const usage = harness.commands.find((command) => command.name === "usage");
  await usage.definition.handler("panel", harness.ctx);
  const panel = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(panel, /Claude Code CLI/, "the panel says which store was read");
});

test("tab opens the read-only history for the newest month", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  const calls = routeHistory(harness, ["2026-09", "2026-10"], {
    "2026-09": historyPayload("2026-09", ["2026-09", "2026-10"], { notes: ["no frozen days for 2026-09 in /tmp/pi-usage"] }),
    "2026-10": historyPayload("2026-10", ["2026-09", "2026-10"], { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }),
  });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();

  overlays[0].component.handleInput("\t");
  assert.deepEqual(calls, [null], "the first tap asks for the month list and the newest month");
  await settle();

  const frame = frameText(overlays[0], 100);
  assert.match(frame.split("\n")[0], /Quota · History · 2026-10/);
  assert.match(frame, /▾ Claude \(Pi\) · 2\.0k in 2026-10 · 1\.2k all-time · 6 prompts/);
  assert.match(frame, /days +10-01 1\.2k · 10-02 800/, "a month lists its frozen days");
  assert.match(frame, /models +claude-opus-5-5 1\.8k · claude-sonnet-5 200/, "…and its token split by model");
  assert.match(frame, /▾ OP-Go · 3\.0k in 2026-10 · 3\.0k all-time · 6 prompts/);
  assert.match(frame, /^ +month 1\.0k · all-time 1\.0k · deepseek-v4\.1-flash$/m, "the base account row is blank");
  assert.match(frame, /#2 +month 2\.0k · all-time 2\.0k · deepseek-v4\.1-flash/);
  assert.equal(/#1\b/.test(frame), false, "history never invents a base number");
  assert.match(frame, /frozen through 2026-10-02 · 2026-10 · read-only/);
  assert.match(frame, /↑↓\/jk move/, "the legend lists movement");
  assert.match(frame, /enter\/space\/h\/l fold/, "…the fold keys");
  assert.match(frame, /←\/\[ prev month/);
  assert.match(frame, /\]\/→ next month/);
  assert.match(frame, /tab\/1\/2 now/, "the history legend offers the way back");
  assert.doesNotMatch(frame, /r refresh · tab\/1\/2 now · esc\/q close[\s\S]*enter\/←→/, "the Now-only month keys are gone");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("month navigation only visits months with a file and fetches each once", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  const calls = routeHistory(harness, ["2026-09", "2026-10"], {
    "2026-09": historyPayload("2026-09", ["2026-09", "2026-10"], {
      days: { "2026-09-30": { claude: { tokens: 700, prompts: 2, slots: { "": { tokens: 700, models: { "claude-opus-5-5": { tokens: 700 } } } } } } },
      totals: { lastFrozenDay: "2026-09-30", families: { claude: { totalPrompts: 2, modelUsage: { "claude-opus-5-5": { input: 700 } }, accounts: {} } } },
    }),
    "2026-10": historyPayload("2026-10", ["2026-09", "2026-10"], { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }),
  });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/);

  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /loading 2026-09 …/, "the requested month says it is loading");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-09/);
  assert.match(frameText(overlays[0]), /days +09-30 700/);
  assert.deepEqual(calls, [null, "2026-09"]);

  overlays[0].component.handleInput("\u001b[C");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/);
  assert.deepEqual(calls, [null, "2026-09"], "a month already loaded is not fetched again");

  overlays[0].component.handleInput("\u001b[C");
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/, "there is no newer month with a file");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("a month of many days wraps at 64 columns without dropping a day", async () => {
  const module = await import(EXTENSION);
  const days = {};
  for (let day = 1; day <= 20; day += 1) {
    const key = `2026-10-${String(day).padStart(2, "0")}`;
    days[key] = {
      claude: {
        tokens: day * 1_000,
        prompts: 1,
        slots: { "": { tokens: day * 1_000, models: { "claude-opus-5-5": { tokens: day * 1_000 } } } },
      },
    };
  }
  const harness = makeHarness({ report: overlayReport() });
  routeHistory(harness, ["2026-10"], {
    "2026-10": historyPayload("2026-10", ["2026-10"], { days, totals: null }),
  });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();

  const rendered = overlays[0].component.render(64);
  assert.equal(rendered.length, 40);
  assert.ok(rendered.every((line) => plain(line).length <= 64), "no line is wider than the terminal");
  const frame = plain(rendered.join("\n"));
  for (let day = 1; day <= 20; day += 1) {
    const key = `10-${String(day).padStart(2, "0")}`;
    assert.ok(frame.includes(key), `day ${key} survives the wrap instead of being clipped`);
  }

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("the current month merges today from the live report and never double counts", async (t) => {
  const module = await import(EXTENSION);
  // Freeze the clock mid-month. The fixture's frozen day is the 1st, and on the
  // 1st of a real month that row *is* today: the merge guard saw "today is
  // already frozen" and this test failed once a month, on the 1st.
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 15, 12, 0, 0) });
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const today = `${month}-${String(now.getDate()).padStart(2, "0")}`;
  const report = liveReport({
    localStats: {
      claude: {
        hasLocalStats: true,
        todayTotalTokens: 500,
        todayPrompts: 2,
        todayTokensByModel: { "claude-opus-5-5": 500 },
        byAccount: { "": { todayTokens: 500 } },
      },
    },
  });

  const openHistory = async (days) => {
    const harness = makeHarness({ report });
    routeHistory(harness, [month], { [month]: currentMonthHistory(today, month, days) });
    module.default(harness.pi);
    await startSession(harness, null);
    const overlays = installOverlay(harness, { rows: 40 });
    const usage = harness.commands.find((command) => command.name === "usage");
    const pending = usage.definition.handler("", harness.ctx);
    await settle();
    overlays[0].component.handleInput("\t");
    await settle();
    return { overlays, pending };
  };

  const open = await openHistory({});
  const frame = frameText(open.overlays[0]);
  assert.match(frame, /~ \d{4}-\d{2}-\d{2} comes from the live report; it is not frozen in history yet/);
  assert.ok(frame.includes(`${today.slice(5)} 500`), "today's tokens appear in the month's day list");
  assert.match(frame, /Claude \(Pi\) · 900 in/, "the month total includes today once (400 frozen + 500 live)");
  open.overlays[0].component.handleInput("\u001b");
  await open.pending;

  // If the durable month already has today's row (the writer froze it), the
  // report's open-day aggregate must not be added on top of it.
  const frozenDay = {
    [today]: { claude: { tokens: 400, prompts: 1, slots: { "": { tokens: 400, prompts: 1, models: { "claude-opus-5-5": { tokens: 400 } } } } } },
  };
  const already = await openHistory(frozenDay);
  const frozenFrame = frameText(already.overlays[0]);
  assert.doesNotMatch(frozenFrame, /comes from the live report/, "a frozen today is not merged again");
  assert.match(frozenFrame, /Claude \(Pi\) · 800 in/, "the frozen day is counted once (400 + 400)");
  already.overlays[0].component.handleInput("\u001b");
  await already.pending;
});

test("a damaged month and a failed history fetch are lines, not throws", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  routeHistory(harness, ["2026-10"], {
    "2026-10": historyPayload("2026-10", ["2026-10"], {
      days: {},
      notes: ["2026-09 was quarantined as tokens-2026-09.json.corrupt-1; its frozen days are missing"],
    }),
  });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();
  const frame = frameText(overlays[0]);
  assert.match(frame, /! 2026-09 was quarantined as tokens-2026-09\.json\.corrupt-1/);
  assert.match(frame, /no token history for 2026-10/);

  // The next fetch fails: the error is a line and the previous month stays usable.
  harness.pi.exec = async () => {
    throw new Error("stats --json exploded");
  };
  overlays[0].component.handleInput("r");
  await settle();
  assert.match(frameText(overlays[0]), /! stats --json exploded/);
  assert.match(frameText(overlays[0]), /history failed/);

  // A pathological thrown message still paints one capped line, not a page.
  harness.pi.exec = async () => {
    throw new Error(`stats failed: ${"x".repeat(600)}`);
  };
  overlays[0].component.handleInput("r");
  await settle();
  const cappedFrame = frameText(overlays[0]);
  assert.match(cappedFrame, /stats failed:/, "the thrown cause is painted");
  assert.ok((cappedFrame.match(/x/g) ?? []).length <= 160, "the thrown cause is capped at 160 characters like a stderr line");
  assert.match(cappedFrame, /x…/, "the cap is marked with an ellipsis");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("a failed fetch of an uncached month is not also a loading line", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  const calls = routeHistory(harness, ["2026-09", "2026-10"], {
    "2026-10": historyPayload("2026-10", ["2026-09", "2026-10"], { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }),
  });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/);

  // 2026-09 has no payload yet, so the failure lands on a month with no frame to
  // fall back on. "loading" is not the post-error state any more.
  harness.pi.exec = async () => {
    throw new Error("stats --json exploded");
  };
  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /loading 2026-09 …/, "the request is visible while it runs");
  await settle();
  const frame = frameText(overlays[0], 100);
  assert.match(frame, /! stats --json exploded/);
  assert.match(frame, /no history for this month; press r to retry/);
  assert.doesNotMatch(frame, /loading/, "a failed fetch does not also claim to be loading");
  assert.match(frame, /history failed/, "the header names the state");

  // r retries the month that failed, not the newest one.
  let retried = null;
  harness.pi.exec = async (runner, argv) => {
    // r on History also forces a report refresh; only the stats call is the retry.
    if (!argv.includes("stats")) return { stdout: "", stderr: "", code: 0 };
    const index = argv.indexOf("--month");
    retried = index === -1 ? null : argv[index + 1];
    return { stdout: JSON.stringify(historyPayload("2026-09", ["2026-09", "2026-10"], { days: {}, totals: null })), stderr: "", code: 0 };
  };
  overlays[0].component.handleInput("r");
  await settle();
  assert.equal(retried, "2026-09", "the retry asks for the month that failed");
  assert.doesNotMatch(frameText(overlays[0]), /stats --json exploded/);
  assert.deepEqual(calls, [null], "the month that failed was requested before the stub replaced the router");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("a report generated before midnight is not merged into today", async (t) => {
  const module = await import(EXTENSION);
  // A pi session that crossed 00:00 still holds 11-02's totals, while the clock
  // (and the month file's missing row) say 11-03. Merging under today's key put
  // yesterday's frozen 999 on top of today's empty day: 999 read as 1.9k.
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 3, 9, 0, 0) });
  const month = "2026-11";
  const report = liveReport({
    generatedAt: new Date(2026, 10, 2, 23, 59, 0).toISOString(),
    localStats: {
      claude: {
        hasLocalStats: true,
        todayTotalTokens: 999,
        todayPrompts: 2,
        todayTokensByModel: { "claude-opus-5-5": 999 },
        byAccount: { "": { todayTokens: 999, todayPrompts: 2, todayTokensByModel: { "claude-opus-5-5": 999 } } },
      },
    },
  });
  const frozen = {
    "2026-11-02": {
      claude: { tokens: 999, prompts: 3, slots: { "": { tokens: 999, prompts: 3, models: { "claude-opus-5-5": { tokens: 999, messages: 3 } } } } },
    },
  };

  const openHistory = async (days) => {
    const harness = makeHarness({ report });
    routeHistory(harness, [month], { [month]: historyPayload(month, [month], { days, totals: null }) });
    module.default(harness.pi);
    await startSession(harness, null);
    const overlays = installOverlay(harness, { rows: 40 });
    const usage = harness.commands.find((command) => command.name === "usage");
    const pending = usage.definition.handler("", harness.ctx);
    await settle();
    overlays[0].component.handleInput("\t");
    await settle();
    return { overlays, pending };
  };

  const open = await openHistory(frozen);
  const frame = frameText(open.overlays[0], 120);
  assert.match(frame, /Claude \(Pi\) · 999 in 2026-11 · 3 prompts/, "the frozen 11-02 is counted once, prompts included");
  assert.match(frame, /days +11-02 999/);
  assert.doesNotMatch(frame, /days .*11-03/, "yesterday's totals are never painted under today's key");
  assert.doesNotMatch(frame, /comes from the live report/, "no merge happened, so no merge note");
  assert.match(frame, /the live report is from 2026-11-02; 2026-11-03 is not merged/);
  open.overlays[0].component.handleInput("\u001b");
  await open.pending;

  // With yesterday still unfrozen the merge is skipped whole: a live day that
  // belongs to another date is not silently re-dated to today.
  const unfrozen = await openHistory({});
  const unfrozenFrame = frameText(unfrozen.overlays[0], 120);
  assert.match(unfrozenFrame, /no token history for 2026-11/, "nothing frozen and nothing merged");
  assert.doesNotMatch(unfrozenFrame, /11-03 999/);
  unfrozen.overlays[0].component.handleInput("\u001b");
  await unfrozen.pending;
});

test("the cached report's older day is not merged into today either", async (t) => {
  const module = await import(EXTENSION);
  // The first frame paints ~/.cache/pi-quota/usage.json, which can be days old.
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 3, 9, 0, 0) });
  const month = "2026-11";
  const report = liveReport({
    generatedAt: new Date(2026, 10, 1, 18, 30, 0).toISOString(),
    localStats: {
      claude: {
        hasLocalStats: true,
        todayTotalTokens: 1_500,
        todayPrompts: 4,
        todayTokensByModel: { "claude-opus-5-5": 1_500 },
        byAccount: { "": { todayTokens: 1_500, todayPrompts: 4, todayTokensByModel: { "claude-opus-5-5": 1_500 } } },
      },
    },
  });
  const days = {
    "2026-11-01": {
      claude: { tokens: 1_500, prompts: 4, slots: { "": { tokens: 1_500, prompts: 4, models: { "claude-opus-5-5": { tokens: 1_500, messages: 4 } } } } },
    },
  };
  const harness = makeHarness({ report });
  routeHistory(harness, [month], { [month]: historyPayload(month, [month], { days, totals: null }) });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();

  const frame = frameText(overlays[0], 120);
  assert.match(frame, /Claude \(Pi\) · 1\.5k in 2026-11 · 4 prompts/, "a 11-01 cache does not add itself to 11-03");
  assert.match(frame, /days +11-01 1\.5k/);
  assert.doesNotMatch(frame, /days .*11-03/);
  assert.match(frame, /the live report is from 2026-11-01; 2026-11-03 is not merged/);

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("an out-of-order history answer never moves the page off the last keypress", async () => {
  const module = await import(EXTENSION);
  const months = ["2026-08", "2026-09", "2026-10"];
  const days = (key, tokens) => ({
    [key]: {
      claude: { tokens, prompts: 1, slots: { "": { tokens, prompts: 1, models: { "claude-opus-5-5": { tokens, messages: 1 } } } } },
    },
  });
  const harness = makeHarness({ report: overlayReport() });
  const { calls, answer } = routeHistoryDeferred(harness);
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  answer(null, historyPayload("2026-10", months, { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }));
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/);

  // Two ← presses, two fetches in flight. The header names the newest request,
  // not the first one: it is the one the page is waiting for.
  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /loading 2026-09 …/);
  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /loading 2026-08 …/);
  assert.deepEqual(calls, [null, "2026-09", "2026-08"]);

  // The newer request answers first, then the older one lands late. The page
  // stays on the month the last keypress asked for and never skips a month.
  answer("2026-08", historyPayload("2026-08", months, { days: days("2026-08-31", 800), totals: null }));
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-08/);
  assert.match(frameText(overlays[0]), /days +08-31 800/);
  answer("2026-09", historyPayload("2026-09", months, { days: days("2026-09-30", 900), totals: null }));
  await settle();
  const frame = frameText(overlays[0], 120);
  assert.match(frame, /Quota · History · 2026-08/, "a late answer for 09 does not snap the page back to it");
  assert.match(frame, /days +08-31 800/);
  assert.doesNotMatch(frame, /loading/, "nothing is loading once both answers landed");

  // The late answer is cached all the same: ← costs no second fetch.
  overlays[0].component.handleInput("\u001b[C");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-09/);
  assert.match(frameText(overlays[0]), /days +09-30 900/);
  assert.deepEqual(calls, [null, "2026-09", "2026-08"], "a month that already answered is not fetched again");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("a fetch for a month the user already left does not claim the header", async () => {
  const module = await import(EXTENSION);
  const months = ["2026-08", "2026-09", "2026-10"];
  const harness = makeHarness({ report: overlayReport() });
  const { answer, fail } = routeHistoryDeferred(harness);
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  answer(null, historyPayload("2026-10", months, { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }));
  await settle();

  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /loading 2026-09 …/);
  // Back to the cached month while 09 is still in flight: its page is served, so
  // the header must not keep saying that a month nobody is looking at loads.
  overlays[0].component.handleInput("\u001b[C");
  await settle();
  const frame = frameText(overlays[0], 120);
  assert.match(frame, /Quota · History · 2026-10/);
  assert.doesNotMatch(frame, /loading 2026-09/);
  answer("2026-09", historyPayload("2026-09", months, { days: {}, totals: null }));
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/, "the late answer leaves the page alone");

  // A failure for a month the user has left is not painted over the page either:
  // its "press r to retry" would retry 10, not the fetch that failed.
  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /Quota · History · 2026-09/, "09 is cached now");
  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /loading 2026-08 …/);
  overlays[0].component.handleInput("\u001b[C");
  fail("2026-08");
  await settle();
  const afterFailure = frameText(overlays[0], 140);
  assert.match(afterFailure, /Quota · History · 2026-09/);
  assert.doesNotMatch(afterFailure, /history lock|history failed/, "a failure for 08 does not claim the 09 page");
  assert.match(afterFailure, /no token history for 2026-09/, "the cached 09 page is still served");

  // Going back to 08 asks again, and only then does its failure belong on screen.
  overlays[0].component.handleInput("\u001b[D");
  assert.match(frameText(overlays[0]), /loading 2026-08 …/);
  fail("2026-08");
  await settle();
  const back = frameText(overlays[0], 140);
  assert.match(back, /! stats: another piquota run holds the history lock/);
  assert.match(back, /history failed/);
  assert.match(back, /no history for this month; press r to retry/);

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("a failed stats run reports the CLI's cause, not the JSON parser's", async () => {
  const module = await import(EXTENSION);
  const month = "2026-10";
  const harness = makeHarness({ report: overlayReport() });
  routeHistory(harness, [month], { [month]: historyPayload(month, [month], { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }) });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/);

  const failWith = (result) => {
    harness.pi.exec = async () => result;
    overlays[0].component.handleInput("r");
  };

  // An empty stdout used to surface as "Unexpected end of JSON input", which
  // names the parser instead of the cause: the CLI's own first stderr line.
  failWith({ stdout: "", stderr: "stats: another piquota run holds the history lock (/tmp/x/cache/local-sessions.json.lock); try again in a moment\nsecond line\n", code: 1 });
  await settle();
  let frame = frameText(overlays[0], 140);
  assert.match(frame, /! stats: another piquota run holds the history lock/);
  assert.doesNotMatch(frame, /Unexpected end of JSON input/);
  assert.doesNotMatch(frame, /second line/, "one stderr line, not the whole transcript");
  assert.match(frame, /press r to retry/, "the failure keeps its retry hint even with a month on screen");
  const narrow = overlays[0].component.render(64);
  assert.ok(narrow.every((line) => plain(line).length <= 64), "a long stderr cause wraps instead of clipping the pane");
  assert.match(plain(narrow.join("\n")), /press r to retry/, "the hint survives the wrap, not just the wide pane");

  // No stderr at all: the exit status is the cause.
  failWith({ stdout: "", stderr: "", code: 2 });
  await settle();
  frame = frameText(overlays[0], 140);
  assert.match(frame, /! piquota stats exited 2/);

  // Half-written JSON with a reason on stderr: the reason wins.
  failWith({ stdout: '{"schemaVersion":1,"months":[', stderr: "stats: no frozen token history at /tmp/pi-usage\n", code: 0 });
  await settle();
  assert.match(frameText(overlays[0], 140), /! stats: no frozen token history at \/tmp\/pi-usage/);

  // Whatever the CLI prints, a credential or an identity never reaches the frame.
  failWith({ stdout: "", stderr: "probe failed for dev@example.com with sk-ant-abcdefghijklmnop\n", code: 1 });
  await settle();
  frame = frameText(overlays[0], 140);
  assert.match(frame, /! probe failed for <email> with sk-ant-ab<redacted>/);
  assert.doesNotMatch(frame, /dev@example\.com|abcdefghijklmnop/);

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("History says a report refresh is running, because its today row waits on it", async () => {
  const module = await import(EXTENSION);
  const month = "2026-10";
  const report = overlayReport();
  const harness = makeHarness({ report });
  routeHistory(harness, [month], { [month]: historyPayload(month, [month], { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }) });
  const routed = harness.pi.exec;
  let releaseReport = null;
  // Hold the report run open: the overlay is painted while it is still running.
  harness.pi.exec = async (runner, argv, options) => {
    if (argv.includes("stats")) return routed(runner, argv, options);
    if (argv.includes("omarchy")) return { stdout: "", stderr: "", code: 0 };
    return new Promise((resolve) => {
      releaseReport = () => resolve({ stdout: JSON.stringify(withFamilies(report)), stderr: "", code: 0 });
    });
  };
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  assert.ok(releaseReport, "the background report refresh is in flight");

  overlays[0].component.handleInput("\t");
  await settle();
  const frame = frameText(overlays[0], 120);
  assert.match(frame, /Quota · History · 2026-10/);
  assert.match(frame, /refreshing …/, "History's live today row depends on the running report refresh");

  releaseReport();
  await settle();
  assert.doesNotMatch(frameText(overlays[0], 120), /refreshing …/, "the indicator clears when the refresh lands");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("a multi-account family keeps every account row when the month only used one", async () => {
  const module = await import(EXTENSION);
  const month = "2026-10";
  const days = {
    "2026-10-01": {
      "opencode-go": {
        tokens: 2_000,
        prompts: 4,
        slots: { "2": { tokens: 2_000, prompts: 4, models: { "deepseek-v4.1-flash": { tokens: 2_000, messages: 4 } } } },
      },
    },
  };
  const totals = {
    lastFrozenDay: "2026-10-01",
    families: {
      "opencode-go": {
        totalPrompts: 6,
        modelUsage: { "deepseek-v4.1-flash": { input: 3_000 } },
        accounts: {
          "": { modelUsage: { "deepseek-v4.1-flash": { input: 1_000 } } },
          "#2": { modelUsage: { "deepseek-v4.1-flash": { input: 2_000 } } },
        },
      },
    },
  };
  const harness = makeHarness({ report: overlayReport() });
  routeHistory(harness, [month], { [month]: historyPayload(month, [month], { days, totals }) });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();

  const frame = frameText(overlays[0], 100);
  assert.match(frame, /▾ OP-Go · 2\.0k in 2026-10/, "a family with more than one account uses the Now short name");
  assert.match(frame, /^ +month 0 · all-time 1\.0k$/m, "the idle account keeps its all-time row");
  assert.match(frame, /#2 +month 2\.0k · all-time 2\.0k · deepseek-v4\.1-flash/);

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("History opens on the live month even before its first freeze", async (t) => {
  const module = await import(EXTENSION);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 2, 9, 0, 0) });
  const live = "2026-11";
  const months = ["2026-09", "2026-10", live];
  const report = liveReport({
    localStats: {
      claude: {
        hasLocalStats: true,
        todayTotalTokens: 500,
        todayPrompts: 2,
        todayTokensByModel: { "claude-opus-5-5": 500 },
        byAccount: { "": { todayTokens: 500 } },
      },
    },
  });
  const harness = makeHarness({ report });
  const calls = routeHistory(harness, months, {
    "2026-09": historyPayload("2026-09", months, { days: { "2026-09-30": { claude: { tokens: 700, prompts: 2, slots: {} } } }, totals: null }),
    "2026-10": historyPayload("2026-10", months, { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }),
    [live]: historyPayload(live, months, { days: {}, totals: HISTORY_TOTALS }),
  });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();

  overlays[0].component.handleInput("\t");
  await settle();
  assert.deepEqual(calls, [null], "the first tap asks for the default month");
  const frame = frameText(overlays[0], 100);
  assert.match(frame.split("\n")[0], /Quota · History · 2026-11/, "History opens on the live month, not on the newest file");
  assert.match(frame, /~ 2026-11-02 comes from the live report/, "the live day is merged on the 2nd, with no month file at all");
  assert.match(frame, /days +11-02 500/);
  assert.match(frame, /Claude \(Pi\) · 500 in 2026-11/);

  overlays[0].component.handleInput("\u001b[D");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-10/, "← reaches the previous month with a file");
  overlays[0].component.handleInput("\u001b[C");
  await settle();
  assert.match(frameText(overlays[0]), /Quota · History · 2026-11/, "→ comes back to the live month");
  assert.deepEqual(calls, [null, "2026-10"], "the live month stays cached");

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("one family frozen today does not drop another family's live day", async (t) => {
  const module = await import(EXTENSION);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 15, 12, 0, 0) });
  const month = "2026-11";
  const report = liveReport({
    localStats: {
      claude: {
        hasLocalStats: true,
        todayTotalTokens: 500,
        todayPrompts: 2,
        todayTokensByModel: { "claude-opus-5-5": 500 },
        byAccount: { "": { todayTokens: 500 } },
      },
      "opencode-go": {
        hasLocalStats: true,
        todayTotalTokens: 300,
        todayPrompts: 1,
        todayTokensByModel: { "deepseek-v4.1-flash": 300 },
        byAccount: { "": { todayTokens: 300, todayPrompts: 1, todayTokensByModel: { "deepseek-v4.1-flash": 300 } } },
      },
    },
  });
  const days = {
    "2026-11-15": {
      claude: { tokens: 400, prompts: 1, slots: { "": { tokens: 400, prompts: 1, models: { "claude-opus-5-5": { tokens: 400, messages: 1 } } } } },
    },
  };
  const harness = makeHarness({ report });
  routeHistory(harness, [month], { [month]: historyPayload(month, [month], { days, totals: null }) });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();

  const frame = frameText(overlays[0], 100);
  assert.match(frame, /Claude \(Pi\) · 400 in 2026-11/, "a family the writer already froze today is not merged again");
  assert.match(frame, /OpenCode Go \(Pi\) · 300 in 2026-11/, "the other family's live day is still merged");
  assert.match(frame, /~ 2026-11-15 comes from the live report/);

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("the merged live day carries each account's own models", async (t) => {
  const module = await import(EXTENSION);
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 15, 12, 0, 0) });
  const month = "2026-11";
  const report = liveReport({
    localStats: {
      "opencode-go": {
        hasLocalStats: true,
        todayTotalTokens: 500,
        todayPrompts: 2,
        todayTokensByModel: { "deepseek-v4.1-flash": 500 },
        byAccount: {
          "": { todayTokens: 500, todayPrompts: 2, todayTokensByModel: { "deepseek-v4.1-flash": 500 } },
          "#2": { todayTokens: 0, todayPrompts: 0, todayTokensByModel: {} },
        },
      },
    },
  });
  const days = {
    "2026-11-01": {
      "opencode-go": {
        tokens: 2_000,
        prompts: 4,
        slots: { "2": { tokens: 2_000, prompts: 4, models: { "deepseek-v4.1-flash": { tokens: 2_000, messages: 4 } } } },
      },
    },
  };
  const totals = {
    lastFrozenDay: "2026-11-01",
    families: {
      "opencode-go": {
        totalPrompts: 6,
        modelUsage: { "deepseek-v4.1-flash": { input: 2_500 } },
        accounts: {
          "": { modelUsage: { "deepseek-v4.1-flash": { input: 500 } } },
          "#2": { modelUsage: { "deepseek-v4.1-flash": { input: 2_000 } } },
        },
      },
    },
  };
  const harness = makeHarness({ report });
  routeHistory(harness, [month], { [month]: historyPayload(month, [month], { days, totals }) });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");
  const pending = usage.definition.handler("", harness.ctx);
  await settle();
  overlays[0].component.handleInput("\t");
  await settle();

  const frame = frameText(overlays[0], 100);
  assert.match(frame, /^ +month 500 · all-time 500 · deepseek-v4\.1-flash$/m, "the merged day names the model that burned it");
  assert.match(frame, /#2 +month 2\.0k · all-time 2\.0k · deepseek-v4\.1-flash/);

  overlays[0].component.handleInput("\u001b");
  await pending;
});

test("folds and the page survive closing and reopening /usage", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: overlayReport() });
  routeHistory(harness, ["2026-10"], { "2026-10": historyPayload("2026-10", ["2026-10"], { days: HISTORY_OCTOBER, totals: HISTORY_TOTALS }) });
  module.default(harness.pi);
  await startSession(harness, null);
  const overlays = installOverlay(harness, { rows: 40 });
  const usage = harness.commands.find((command) => command.name === "usage");

  let pending = usage.definition.handler("", harness.ctx);
  await settle();
  assert.match(frameText(overlays[0]), /5h window/);
  overlays[0].component.handleInput("\r");
  assert.equal(/5h window/.test(frameText(overlays[0])), false, "Enter folds the section");
  overlays[0].component.handleInput("\u001b");
  await pending;

  pending = usage.definition.handler("", harness.ctx);
  await settle();
  assert.equal(overlays.length, 2, "a second bare /usage builds a new view");
  assert.match(frameText(overlays[1]), /❯ ▸ Claude/, "the fold survived the close: the section is still folded");
  assert.equal(/5h window/.test(frameText(overlays[1])), false);

  overlays[1].component.handleInput("\t");
  await settle();
  assert.match(frameText(overlays[1]), /Quota · History · 2026-10/);
  overlays[1].component.handleInput("\u001b");
  await pending;

  pending = usage.definition.handler("", harness.ctx);
  await settle();
  assert.equal(overlays.length, 3);
  assert.match(frameText(overlays[2]), /Quota · History · 2026-10/, "the page survived too");
  assert.match(frameText(overlays[2]), /days +10-01 1\.2k/, "and its month is fetched again for the new view");
  overlays[2].component.handleInput("1");
  assert.match(frameText(overlays[2]), /❯ ▸ Claude/, "…while the Now page's fold still holds");
  assert.equal(/5h window/.test(frameText(overlays[2])), false);

  overlays[2].component.handleInput("\u001b");
  await pending;
});

test("agent_end is a no-op while no surface is on", async () => {
  const previousDebounce = process.env.PI_QUOTA_EVENT_DEBOUNCE_MS;
  process.env.PI_QUOTA_EVENT_DEBOUNCE_MS = "20";
  try {
    const module = await import(EXTENSION);
    let execCalls = 0;
    const harness = makeHarness();
    const originalExec = harness.pi.exec;
    /** @type {(...args: any[]) => Promise<any>} */
    harness.pi.exec = async (...args) => {
      execCalls++;
      return originalExec(...args);
    };
    module.default(harness.pi);
    await startSession(harness, null);
    const initialCalls = execCalls;

    await harness.handlers.get("agent_end")({}, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(execCalls, initialCalls, "no surface is visible, so nothing polls");
  } finally {
    if (previousDebounce === undefined) delete process.env.PI_QUOTA_EVENT_DEBOUNCE_MS;
    else process.env.PI_QUOTA_EVENT_DEBOUNCE_MS = previousDebounce;
  }
});

test("agent_end triggers a debounced quota refresh and agent_start cancels pending", async () => {
  const previousDebounce = process.env.PI_QUOTA_EVENT_DEBOUNCE_MS;
  process.env.PI_QUOTA_EVENT_DEBOUNCE_MS = "40";
  try {
    const module = await import(EXTENSION);
    let execCalls = 0;
    const harness = makeHarness();
    const originalExec = harness.pi.exec;
    harness.pi.exec = async (...args) => {
      execCalls++;
      return originalExec(...args);
    };
    module.default(harness.pi);
    await startSession(harness);
    const initialCalls = execCalls;

    const onAgentEnd = harness.handlers.get("agent_end");
    assert.equal(typeof onAgentEnd, "function", "must register agent_end handler");

    // 1. Calling agent_start before debounce cancels it
    await onAgentEnd({}, harness.ctx);
    const onAgentStart = harness.handlers.get("agent_start");
    assert.equal(typeof onAgentStart, "function", "must register agent_start handler");
    onAgentStart({}, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(execCalls, initialCalls, "agent_start must have cancelled the debounced refresh");

    // 2. Calling agent_end without interruption triggers refresh
    await onAgentEnd({}, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(execCalls > initialCalls, "agent_end must have triggered a quota refresh");
  } finally {
    if (previousDebounce === undefined) delete process.env.PI_QUOTA_EVENT_DEBOUNCE_MS;
    else process.env.PI_QUOTA_EVENT_DEBOUNCE_MS = previousDebounce;
  }
});

