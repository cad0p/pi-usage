/**
 * Local token statistics tests.
 *
 * Every scan runs against a synthetic session tree, a temp cache and a temp
 * history directory: no test reads the real Pi store, writes under the real
 * `~/.pi`, or touches `~/.cache`.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runStatsCommand } from "../src/cli/commands/stats.js";
import { collectQuota } from "../src/engine.js";
import {
  acquireHistoryLock,
  emptyTotals,
  applyDayToTotals,
  loadTotals,
  parseTotals,
  refreshHistoryLock,
  releaseHistoryLock,
  rebuildTotalsFromMonths,
  resolveHistoryDir,
  resolveMonthPath,
  resolveTotalsPath,
  totalsToJson,
  writeJsonAtomic,
} from "../src/local/history.js";
import {
  collectLocalStats,
  localDayKey,
  resolveLocalStatsCachePath,
  resolveSessionRoots,
  usageFromLine,
} from "../src/local/pi-sessions.js";
import { buildRecords } from "../src/omarchy/record.js";
import { claudeUsageBody, jsonResponse, routedFetch } from "./helpers.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-auth.json", import.meta.url));
const NOW = Date.parse("2026-11-02T18:00:00.000Z");
const TODAY = localDayKey(NOW);
const MONTH = TODAY.slice(0, 7);

let entrySequence = 0;

/** ISO timestamp at local noon, `offset` days from the report time's local day. */
function tsForDay(offset) {
  const date = new Date(NOW);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString();
}

/** Local-noon epoch for an explicit local date, independent of the machine's zone. */
function noonOf(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12, 0, 0, 0).getTime();
}

/** One JSONL assistant message, exactly as Pi writes it. */
function assistantLine(input = {}) {
  entrySequence += 1;
  const usage = input.usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  return JSON.stringify({
    type: "message",
    id: `entry-${entrySequence}`,
    timestamp: input.ts ?? tsForDay(0),
    message: {
      role: input.role ?? "assistant",
      // `provider: null` omits the key, which is how a session written by an
      // older Pi build looks.
      ...(input.provider === null ? {} : { provider: input.provider ?? "anthropic" }),
      model: input.model ?? "claude-opus-5-5",
      ...(input.api ? { api: input.api } : {}),
      usage,
    },
  });
}

function tempTree() {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-local-stats-"));
  const sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  const agentDir = join(dir, "agent");
  return {
    dir,
    sessions,
    agentDir,
    cachePath: join(dir, "cache", "local-sessions.json"),
    historyDir: join(agentDir, "pi-usage"),
    totalsPath: join(agentDir, "pi-usage", "totals.json"),
  };
}

function scan(tree, options = {}) {
  return collectLocalStats({
    roots: [tree.sessions],
    cachePath: tree.cachePath,
    historyDir: tree.historyDir,
    now: NOW,
    budgetMs: 60_000,
    ...options,
  });
}

function writeSession(dir, name, lines) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""), "utf-8");
  return path;
}

function appendSession(path, lines) {
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""), { flag: "a", encoding: "utf-8" });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function totalsOf(tree) {
  return readJson(tree.totalsPath);
}

function monthOf(tree, month = MONTH) {
  return readJson(resolveMonthPath(tree.historyDir, month));
}

/** Synthetic local stats, shaped like the builder's output. */
const LOCAL = {
  hasLocalStats: true,
  hasPromptStats: true,
  todayPrompts: 12,
  todaySessions: 2,
  todayTotalTokens: 34_567,
  todayTokensByModel: { "claude-opus-5-5": 30_000, "claude-sonnet-5": 4_567 },
  weekTokensByModel: { "claude-opus-5-5": 118_422 },
  recentDays: [
    { date: "2026-10-27", messageCount: 0 },
    { date: "2026-10-28", messageCount: 1_000 },
    { date: "2026-10-29", messageCount: 0 },
    { date: "2026-10-30", messageCount: 2_000 },
    { date: "2026-10-31", messageCount: 0 },
    { date: "2026-11-01", messageCount: 3_000 },
    { date: "2026-11-02", messageCount: 34_567 },
  ],
  totalPrompts: 99,
  totalSessions: 7,
  activeDays: 4,
  activeDates: ["2026-10-28", "2026-10-30", "2026-11-01", "2026-11-02"],
  modelUsage: {
    "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
    "claude-sonnet-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
  },
  byAccount: { "#1": { todayTokens: 34_567, weekTokens: 40_567, todayPrompts: 12, totalPrompts: 99, totalTokens: 100 } },
};

function provider(overrides = {}) {
  return {
    family: "claude",
    label: "Claude (Pi)",
    account: "someone@example.com",
    plan: "pro",
    windows: [{ id: "5h", label: "5h window", usedPercent: 25, remainingPercent: 75, resetsAt: null }],
    error: null,
    ok: true,
    source: "/fixture/auth.json",
    updatedAt: "2026-11-02T18:00:00.000Z",
    ...overrides,
  };
}

test("assistant messages map to families and siblings, and unknown providers are ignored", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "--work--/a.jsonl", [
    assistantLine({ provider: "anthropic", model: "claude-opus-5-5", usage: { input: 4, output: 425, cacheRead: 6838, cacheWrite: 6905, totalTokens: 14172 } }),
    assistantLine({ provider: "opencode-go-7", model: "deepseek-v4.1-flash", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } }),
    assistantLine({ provider: "deepinfra", model: "deepseek-ai/DeepSeek", usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1998 } }),
    assistantLine({ provider: "claude-bridge", model: "claude-opus-5-5", usage: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 999 } }),
  ]);

  const result = await scan(tree);

  assert.deepEqual(Object.keys(result.byFamily).sort(), ["claude", "opencode-go"]);
  assert.equal(result.byFamily.claude.todayTotalTokens, 14_172);
  assert.equal(result.byFamily.claude.todayPrompts, 1);
  assert.deepEqual(result.byFamily.claude.todayTokensByModel, { "claude-opus-5-5": 14_172 });
  assert.deepEqual(Object.keys(result.byFamily["opencode-go"].byAccount), ["#7"]);
  assert.equal(result.byFamily["opencode-go"].byAccount["#7"].todayTokens, 110);
  assert.equal(result.byFamily.claude.recentDays.at(-1).date, TODAY);
  assert.equal(result.byFamily.claude.recentDays.length, 7);
});

test("the api field identifies the family when the provider field is missing", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ provider: null, api: "openai-codex-responses", model: "gpt-5.1-codex", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } }),
  ]);
  const result = await scan(tree);
  assert.deepEqual(Object.keys(result.byFamily), ["codex"]);
  assert.equal(result.byFamily.codex.todayTotalTokens, 10);
});

test("assistant messages without any token count are not prompts", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }),
    assistantLine({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const result = await scan(tree);
  assert.deepEqual(result.byFamily, {});
});

test("usageFromLine rejects malformed lines, other roles and non-message entries", () => {
  assert.equal(usageFromLine("not json", NOW), null);
  assert.equal(usageFromLine(JSON.stringify({ type: "message", message: { role: "user", provider: "anthropic", usage: { input: 1 } } }), NOW), null);
  assert.equal(usageFromLine(JSON.stringify({ type: "custom", message: { role: "assistant", provider: "anthropic", usage: { input: 1 } } }), NOW), null);
  assert.equal(usageFromLine(JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic" } }), NOW), null);
});

test("a totals file written before the label fix reads back as one unnumbered base account", () => {
  const totals = parseTotals({
    schemaVersion: 1,
    lastFrozenDay: "2026-11-02",
    families: {
      "opencode-go": {
        firstDay: "2026-11-01",
        activeDates: ["2026-11-02"],
        totalPrompts: 2,
        totalSessions: 1,
        modelUsage: {},
        accounts: {
          "#1": { totalPrompts: 2, totalSessions: 1, modelUsage: {} },
          "#2": { totalPrompts: 0, totalSessions: 0, modelUsage: {} },
        },
      },
    },
  });
  assert.ok(totals);
  assert.deepEqual(Array.from(totals.families.get("opencode-go").accounts.keys()).sort(), ["", "#2"]);
});

test("the base account is unnumbered and siblings sort numerically", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(0), provider: "opencode-go", usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), provider: "opencode-go-2", usage: { input: 22, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), provider: "opencode-go-10", usage: { input: 110, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(-1), provider: "opencode-go-7", usage: { input: 70, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(-20), provider: "opencode-go-2", usage: { input: 5_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);

  const result = await scan(tree);
  const stats = result.byFamily["opencode-go"];

  assert.deepEqual(Object.keys(stats.byAccount), ["", "#2", "#7", "#10"]);
  assert.equal(stats.byAccount[""].todayTokens, 11);
  assert.equal(stats.byAccount["#2"].todayTokens, 22);
  assert.equal(stats.byAccount["#2"].weekTokens, 22, "the 20-day-old message is outside the 7-day window");
  assert.equal(stats.byAccount["#2"].totalTokens, 5_022);
  assert.equal(stats.byAccount["#7"].todayTokens, 0);
  assert.equal(stats.byAccount["#7"].weekTokens, 70);
  assert.equal(stats.byAccount["#10"].todayTokens, 110);
  assert.equal(stats.byAccount["#10"].todayPrompts, 1);
  assert.equal(stats.todayTotalTokens, 143);
  assert.equal(stats.totalPrompts, 5);
  assert.equal(stats.weekTokensByModel["claude-opus-5-5"], 213);
  assert.equal(stats.activeDates.length, 3);
  assert.equal(result.scan.frozenDays, 2, "yesterday and the 20-day-old day are closed");
});

test("a grown session file is read from its last complete line", async () => {
  const tree = tempTree();
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  assert.equal(first.scan.scanned, 1);
  assert.equal(first.scan.bytesRead, statSync(file).size);
  assert.equal(first.byFamily.claude.todayTotalTokens, 10);

  const appended = assistantLine({ usage: { input: 25, output: 0, cacheRead: 0, cacheWrite: 0 } });
  appendSession(file, [appended]);

  const second = await scan(tree);
  assert.equal(second.scan.scanned, 1);
  assert.equal(second.scan.reused, 0);
  assert.equal(second.scan.bytesRead, Buffer.byteLength(appended) + 1, "only the appended line is read");
  assert.equal(second.byFamily.claude.todayTotalTokens, 35);
  assert.equal(second.byFamily.claude.todayPrompts, 2);

  const third = await scan(tree);
  assert.equal(third.scan.reused, 1);
  assert.equal(third.scan.bytesRead, 0);
  assert.equal(third.byFamily.claude.todayTotalTokens, 35);
});

test("an unterminated last line is counted once it is completed", async () => {
  const tree = tempTree();
  const file = join(tree.sessions, "a.jsonl");
  const partial = assistantLine({ usage: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0 } });
  writeFileSync(file, `${assistantLine({ usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } })}\n${partial.slice(0, 40)}`, "utf-8");

  const first = await scan(tree);
  assert.equal(first.byFamily.claude.todayPrompts, 1, "the half-written line is not counted yet");

  appendSession(file, [partial.slice(40)]);
  // The appended chunk has no trailing newline of its own; write one.
  writeFileSync(file, "\n", { flag: "a" });

  const second = await scan(tree);
  assert.equal(second.byFamily.claude.todayPrompts, 2);
  assert.equal(second.byFamily.claude.todayTotalTokens, 61);
});

test("a session file that shrank is rescanned from zero", async () => {
  const tree = tempTree();
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  assert.equal(first.byFamily.claude.todayTotalTokens, 1_000);
  assert.equal(first.byFamily.claude.totalSessions, 1);

  writeSession(tree.sessions, "a.jsonl", [assistantLine({ usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  const second = await scan(tree);
  assert.ok(statSync(file).size < first.scan.bytesRead);
  assert.equal(second.byFamily.claude.todayTotalTokens, 7);
  assert.equal(second.byFamily.claude.todayPrompts, 1);
  assert.equal(second.byFamily.claude.totalPrompts, 1);
});

test("deleting a session file keeps the days already frozen in history", async () => {
  const tree = tempTree();
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  assert.equal(first.scan.frozenDays, 1);
  assert.equal(first.byFamily.claude.totalPrompts, 2);
  const frozenTotals = totalsOf(tree);
  assert.equal(frozenTotals.lastFrozenDay, localDayKey(Date.parse(tsForDay(-1))));

  unlinkSync(file);
  const second = await scan(tree);
  assert.equal(second.byFamily.claude.todayTotalTokens, 0, "the open day's contribution is gone with the file");
  assert.equal(second.byFamily.claude.totalPrompts, 1, "the frozen day survives the deletion");
  assert.equal(second.byFamily.claude.recentDays.at(-2).messageCount, 100);
  assert.ok(second.byFamily.claude.activeDates.includes(localDayKey(Date.parse(tsForDay(-1)))));
  assert.deepEqual(totalsOf(tree), frozenTotals, "totals are not rewritten by the deletion");
  assert.equal(monthOf(tree).days[localDayKey(Date.parse(tsForDay(-1)))].claude.slots[""].models["claude-opus-5-5"].input, 100);
});

test("deleting a session file only drops its open-day contribution", async () => {
  const tree = tempTree();
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(0), usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  unlinkSync(file);
  const result = await scan(tree);
  assert.deepEqual(result.byFamily, {});
  assert.equal(totalsOf(tree).lastFrozenDay, "");
});

test("two roots that resolve to the same directory are scanned once", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const alias = join(tree.dir, "sessions-alias");
  symlinkSync(tree.sessions, alias);

  const result = await scan(tree, { roots: [tree.sessions, alias] });
  assert.equal(result.scan.files, 1, "the same directory twice is one root");
  assert.equal(result.byFamily.claude.todayPrompts, 1);
  assert.equal(result.byFamily.claude.todayTotalTokens, 10);
});

test("a removed session root removes its open-day contribution", async () => {
  const tree = tempTree();
  const other = join(tree.dir, "other-sessions");
  mkdirSync(other, { recursive: true });
  writeSession(tree.sessions, "a.jsonl", [assistantLine({ usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  writeSession(other, "b.jsonl", [assistantLine({ usage: { input: 8, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  const first = await scan(tree, { roots: [tree.sessions, other] });
  assert.equal(first.byFamily.claude.todayTotalTokens, 11);

  rmSync(other, { recursive: true, force: true });
  const second = await scan(tree, { roots: [tree.sessions, other] });
  assert.equal(second.byFamily.claude.todayTotalTokens, 3);
  assert.equal(second.scan.files, 1);
});

test("today is recomputed from per-day aggregates, and the closed day freezes once", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(0), usage: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  assert.equal(first.byFamily.claude.todayTotalTokens, 30);
  assert.equal(first.byFamily.claude.totalPrompts, 1);
  assert.equal(first.scan.frozenDays, 0);

  const tomorrow = Date.parse(tsForDay(1));
  const second = await scan(tree, { now: tomorrow });
  assert.equal(second.scan.reused, 1, "the file did not change, so no bytes are re-read");
  assert.equal(second.scan.frozenDays, 1);
  assert.equal(second.byFamily.claude.todayTotalTokens, 0);
  assert.equal(second.byFamily.claude.todayPrompts, 0);
  assert.equal(second.byFamily.claude.totalPrompts, 1, "history is intact");
  assert.equal(second.byFamily.claude.recentDays.at(-1).date, localDayKey(tomorrow));
  assert.equal(second.byFamily.claude.recentDays.at(-2).messageCount, 30, "yesterday keeps its tokens");
  const frozen = totalsOf(tree);
  assert.equal(frozen.lastFrozenDay, TODAY);

  const third = await scan(tree, { now: tomorrow });
  assert.deepEqual(totalsOf(tree), frozen, "a second run never freezes the day twice");
});

test("a late append to a frozen day increments history, not the open cache", async () => {
  const tree = tempTree();
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  assert.equal(first.scan.frozenDays, 1);
  assert.equal(first.byFamily.claude.totalPrompts, 1);

  appendSession(file, [assistantLine({ ts: tsForDay(-1), usage: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  const second = await scan(tree);
  assert.equal(second.scan.frozenDays, 0, "the day is already frozen");
  assert.equal(second.byFamily.claude.totalPrompts, 2);
  assert.equal(second.byFamily.claude.todayTotalTokens, 0);
  assert.equal(second.byFamily.claude.recentDays.at(-2).messageCount, 100);
  const day = localDayKey(Date.parse(tsForDay(-1)));
  assert.equal(monthOf(tree).days[day].claude.slots[""].models["claude-opus-5-5"].input, 100);

  const frozen = totalsOf(tree);
  const third = await scan(tree);
  assert.deepEqual(totalsOf(tree), frozen, "the offset was persisted, so the late lines are not applied twice");
  assert.equal(third.byFamily.claude.totalPrompts, 2);
});

test("losing the disposable cache does not double count frozen days", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const frozen = totalsOf(tree);
  assert.equal(frozen.families.claude.totalPrompts, 1, "the rollup holds the frozen day only");

  rmSync(tree.cachePath, { force: true });
  const second = await scan(tree);
  assert.equal(second.scan.scanned, 1, "the cache miss forces a rescan");
  assert.equal(second.byFamily.claude.totalPrompts, 2, "the frozen day is skipped, not re-added");
  assert.equal(second.byFamily.claude.todayTotalTokens, 10);
  assert.deepEqual(totalsOf(tree), frozen);
});

test("a corrupt per-file cache is a cache miss while history survives", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 12, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const frozen = totalsOf(tree);

  mkdirSync(dirname(tree.cachePath), { recursive: true });
  writeFileSync(tree.cachePath, "{not json", "utf-8");
  const second = await scan(tree);
  assert.equal(second.scan.scanned, 1);
  assert.equal(second.byFamily.claude.totalPrompts, 2);
  assert.equal(readJson(tree.cachePath).schemaVersion, 2);
  assert.deepEqual(totalsOf(tree), frozen);
});

test("a corrupt history file is moved aside, warned about, and rebuilt from disk", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const frozen = totalsOf(tree);

  writeFileSync(tree.totalsPath, "{definitely not json", "utf-8");
  const second = await scan(tree);
  assert.ok(second.warnings.some((warning) => warning.includes("moved it to")), second.warnings.join(" | "));
  assert.ok(readdirSync(tree.historyDir).some((name) => name.startsWith("totals.json.corrupt-")));
  assert.deepEqual(totalsOf(tree), frozen, "the history is rebuilt from the session files still on disk");
  assert.equal(second.byFamily.claude.totalPrompts, 2);
});

test("a copied session file does not add its frozen days a second time", async () => {
  const tree = tempTree();
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const frozen = totalsOf(tree);
  const day = localDayKey(Date.parse(tsForDay(-1)));
  assert.equal(frozen.families.claude.totalPrompts, 1, "only the closed day is frozen");
  assert.equal(monthOf(tree).days[day].claude.slots[""].models["claude-opus-5-5"].input, 1_000);

  // A backup restore, a sync tool or a manual cp: the same history under a new
  // path. It is new to the cache, so it must be read as a rescan (frozen days
  // skipped), not as a late write into the day it copies.
  copyFileSync(file, join(tree.sessions, "a-copy.jsonl"));
  const after = await scan(tree);
  assert.equal(after.byFamily.claude.totalPrompts, 2, "the frozen prompt plus today's, each once");
  assert.equal(after.byFamily.claude.todayTotalTokens, 1_000, "today is not doubled by the copy");
  assert.equal(monthOf(tree).days[day].claude.slots[""].models["claude-opus-5-5"].input, 1_000, "the frozen day is untouched");
  assert.deepEqual(totalsOf(tree), frozen, "all-time totals are untouched");

  // The copy is recorded at its own end, so what the copy's session does next
  // is counted normally: only the duplicated prefix is ignored.
  appendSession(join(tree.sessions, "a-copy.jsonl"), [
    assistantLine({ ts: tsForDay(0), usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const continued = await scan(tree);
  assert.equal(continued.byFamily.claude.todayTotalTokens, 1_020);
  assert.equal(continued.byFamily.claude.totalPrompts, 3);
});

test("two sessions with identical head and tail but a different middle are both counted", async () => {
  const tree = tempTree();
  // Same size, identical first and last 40 KB, different middle: the cheap
  // (size, head, tail) fingerprint collides, and dropping the second file would
  // silently lose 250 prompts (review finding N1).
  // The head and tail lines are the *same strings* in both files, so their
  // bytes are identical and only the middle differs.
  const head = [];
  const tail = [];
  for (let index = 0; index < 250; index += 1) {
    head.push(assistantLine({ usage: { input: 1_111, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    tail.push(assistantLine({ usage: { input: 2_222, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  }
  const middleA = [];
  const middleB = [];
  for (let index = 0; index < 250; index += 1) {
    middleA.push(assistantLine({ usage: { input: 3_333, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    middleB.push(assistantLine({ usage: { input: 4_444, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  }
  const fileA = [...head, ...middleA, ...tail];
  const fileB = [...head, ...middleB, ...tail];
  writeSession(tree.sessions, "a.jsonl", fileA);
  writeSession(tree.sessions, "b.jsonl", fileB);
  assert.equal(statSync(join(tree.sessions, "a.jsonl")).size, statSync(join(tree.sessions, "b.jsonl")).size);

  const result = await scan(tree);
  const expected = 2 * (250 * 1_111 + 250 * 2_222) + 250 * 3_333 + 250 * 4_444;
  assert.equal(result.byFamily.claude.todayTotalTokens, expected);
  assert.equal(result.byFamily.claude.todayPrompts, 1_500);
  assert.equal(readJson(tree.cachePath).files[join(tree.sessions, "b.jsonl")].dedupedBy, undefined, "b is not a copy of a");
});

test("a mid-file difference is verified in full before a file is called a copy", async () => {
  // Bounded-cost guard: the cheap fingerprint is only a *candidate*. Two files
  // that differ in the middle must both count, and the full comparison must not
  // be used for files that never matched the sample.
  const tree = tempTree();
  const head = [];
  for (let index = 0; index < 300; index += 1) head.push(assistantLine({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const middleA = [];
  const middleB = [];
  for (let index = 0; index < 300; index += 1) {
    middleA.push(assistantLine({ usage: { input: 111, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    middleB.push(assistantLine({ usage: { input: 222, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  }
  writeSession(tree.sessions, "a.jsonl", [...head, ...middleA]);
  writeSession(tree.sessions, "b.jsonl", [...head, ...middleB]);
  const result = await scan(tree);
  assert.equal(result.byFamily.claude.todayTotalTokens, 600 * 10 + 300 * 111 + 300 * 222);
  assert.equal(result.byFamily.claude.todayPrompts, 1_200);
});

test("deleting the original keeps the copy's open-day contribution", async () => {
  const tree = tempTree();
  const original = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  copyFileSync(original, join(tree.sessions, "b.jsonl"));
  const copied = await scan(tree);
  assert.equal(copied.byFamily.claude.todayPrompts, 2, "the copy contributes nothing while the original exists");

  // The copy was skipped as a duplicate and holds no rows of its own, so the
  // deletion of the original must make the scan adopt it (review finding N4).
  unlinkSync(original);
  const adopted = await scan(tree);
  assert.equal(adopted.byFamily.claude.todayPrompts, 2, "the copy is read once the original is gone");
  assert.equal(adopted.byFamily.claude.todayTotalTokens, 2_000);
  assert.equal(readJson(tree.cachePath).files[join(tree.sessions, "b.jsonl")].dedupedBy, undefined);
});

test("a lock taken over from a slow run is not deleted by that run on its way out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-lock-"));
  const lockPath = join(dir, "x.lock");
  const now = 1_000_000;

  const first = acquireHistoryLock({ lockPath, now });
  assert.equal(first.acquired, true);
  assert.equal(typeof first.token, "string");

  // Age it past the stale timeout: a second run takes it over.
  const old = new Date(now - 200_000);
  utimesSync(lockPath, old, old);
  const second = acquireHistoryLock({ lockPath, now });
  assert.equal(second.acquired, true, "a stale lock is taken over");

  // The first run finishes late. Releasing with its own token must not remove
  // the second run's lock, or a third run would walk straight in (N2).
  assert.equal(releaseHistoryLock(first), false);
  assert.equal(refreshHistoryLock(first), false, "the first run knows it lost the lock");
  const third = acquireHistoryLock({ lockPath, now });
  assert.equal(third.acquired, false, "the lock still belongs to the second run");

  assert.equal(refreshHistoryLock(second), true);
  assert.equal(releaseHistoryLock(second), true);
  assert.equal(acquireHistoryLock({ lockPath, now }).acquired, true, "once released, the next run takes it");
});

test("a run that loses the lock mid-scan writes no history and no cache, even with few files", async () => {
  const tree = tempTree();
  for (let index = 0; index < 3; index += 1) {
    writeSession(tree.sessions, `f${index}.jsonl`, [
      assistantLine({ ts: tsForDay(-1), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      assistantLine({ ts: tsForDay(0), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]);
  }
  // Three files never reach the every-eight-files refresh, so only the check
  // right before the writes can notice a takeover (review finding N8). The
  // clock stands in for the other run: it swaps the owner token while we scan.
  let calls = 0;
  const clock = () => {
    calls += 1;
    if (calls === 6) writeFileSync(`${tree.cachePath}.lock`, "someone-else\n", "utf-8");
    return NOW;
  };
  const result = await collectLocalStats({
    roots: [tree.sessions],
    cachePath: tree.cachePath,
    historyDir: tree.historyDir,
    now: NOW,
    budgetMs: 60_000,
    clock,
  });

  assert.equal(result.scan.locked, true);
  assert.equal(result.scan.frozenDays, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("took the history lock over")), result.warnings.join(" | "));
  assert.equal(existsSync(tree.totalsPath), false, "no rollup is written by a run that lost the lock");
  assert.equal(existsSync(resolveMonthPath(tree.historyDir, MONTH)), false, "no month file either");
  assert.equal(existsSync(tree.cachePath), false, "and no cache");
  assert.equal(readFileSync(`${tree.cachePath}.lock`, "utf-8").trim(), "someone-else", "the successor's lock is left alone");
});

test("a copy chain resolves to its root, so deleting a middle copy changes nothing", async () => {
  const tree = tempTree();
  const a = writeSession(tree.sessions, "A.jsonl", [
    assistantLine({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  copyFileSync(a, join(tree.sessions, "B.jsonl"));
  await scan(tree);
  copyFileSync(join(tree.sessions, "B.jsonl"), join(tree.sessions, "C.jsonl"));
  const all = await scan(tree);
  assert.equal(all.byFamily.claude.todayPrompts, 2, "three identical files, one session");

  // C must point at A, not at B: deleting the middle link used to orphan C and
  // count its lines a second time (review finding N11).
  const files = readJson(tree.cachePath).files;
  assert.equal(files[join(tree.sessions, "C.jsonl")].dedupedBy, join(tree.sessions, "A.jsonl"));

  unlinkSync(join(tree.sessions, "B.jsonl"));
  const middle = await scan(tree);
  assert.equal(middle.byFamily.claude.todayPrompts, 2, "the chain still bottoms out in a live original");

  unlinkSync(a);
  const root = await scan(tree);
  assert.equal(root.byFamily.claude.todayPrompts, 2, "with the root gone the copy is adopted, once");
});

test("an unreadable month never causes a reduced totals.json write", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("permissions are not enforced for root");
    return;
  }
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: new Date(noonOf("2026-09-05")).toISOString(), usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 2);
  const september = resolveMonthPath(tree.historyDir, "2026-09");

  // If the rollup is lost while a month is unreadable, rebuilding from the
  // readable subset would permanently drop that month's frozen counts (N9).
  chmodSync(september, 0o000);
  rmSync(tree.totalsPath, { force: true });
  try {
    const blocked = await scan(tree);
    assert.ok(blocked.warnings.some((warning) => warning.includes("could not be read")), blocked.warnings.join(" | "));
    assert.equal(existsSync(tree.totalsPath), false, "no reduced totals.json is written");
    assert.equal(blocked.scan.frozenDays, 0);
  } finally {
    chmodSync(september, 0o600);
  }

  const healed = await scan(tree);
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 2);
  assert.equal(healed.byFamily.claude.totalPrompts, 2);
});

test("an unreadable in-window month keeps its open day cached and does not rescan repeatedly", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("permissions are not enforced for root");
    return;
  }
  const tree = tempTree();
  const frozenRows = {
    claude: {
      sessions: 1,
      slots: { "": { sessions: 1, models: { m1: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } } } },
    },
  };
  const baseline = emptyTotals();
  applyDayToTotals(baseline, "2026-10-31", frozenRows);
  baseline.lastFrozenDay = "2026-10-31";
  writeJsonAtomic(resolveMonthPath(tree.historyDir, "2026-10"), {
    schemaVersion: 1,
    month: "2026-10",
    days: { "2026-10-31": frozenRows },
  });
  writeJsonAtomic(tree.totalsPath, totalsToJson(baseline));
  const november = resolveMonthPath(tree.historyDir, MONTH);
  writeJsonAtomic(november, { schemaVersion: 1, month: MONTH, days: {} });
  const before = readFileSync(tree.totalsPath, "utf-8");
  const session = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 400, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);

  chmodSync(november, 0o000);
  try {
    const first = await scan(tree);
    assert.equal(first.scan.scanned, 1);
    assert.equal(first.scan.frozenDays, 0);
    assert.ok(first.warnings.some((warning) => warning.includes("could not read")), first.warnings.join(" | "));
    assert.equal(readFileSync(tree.totalsPath, "utf-8"), before, "the existing rollup stays byte-identical");
    const day = localDayKey(Date.parse(tsForDay(-1)));
    assert.ok(readJson(tree.cachePath).files[session].days[day], "the closed day remains open in the cache");

    const repeated = await scan(tree);
    assert.equal(repeated.scan.scanned, 0, "an unreadable window month does not force a full-store rescan");
    assert.equal(repeated.scan.frozenDays, 0);
    assert.equal(readFileSync(tree.totalsPath, "utf-8"), before);
    assert.ok(readJson(tree.cachePath).files[session].days[day]);
  } finally {
    chmodSync(november, 0o600);
  }

  const readable = await scan(tree);
  assert.equal(readable.scan.scanned, 0, "the cached day freezes when the month becomes readable");
  assert.equal(readable.scan.frozenDays, 1);
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 2);
  assert.equal(monthOf(tree).days[localDayKey(Date.parse(tsForDay(-1)))].claude.slots[""].models["claude-opus-5-5"].messages, 1);
});

test("late writes wait in cache while their month is unreadable and apply once readable", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("permissions are not enforced for root");
    return;
  }
  const tree = tempTree();
  const session = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const frozenTotals = readFileSync(tree.totalsPath, "utf-8");
  const month = resolveMonthPath(tree.historyDir, MONTH);
  chmodSync(month, 0o000);
  try {
    appendSession(session, [assistantLine({ ts: tsForDay(-1), usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
    const blocked = await scan(tree);
    assert.equal(blocked.scan.scanned, 1);
    assert.equal(readFileSync(tree.totalsPath, "utf-8"), frozenTotals);
    const day = localDayKey(Date.parse(tsForDay(-1)));
    assert.ok(readJson(tree.cachePath).pendingLate[day], "the unapplied late delta is retained in the cache");

    const repeated = await scan(tree);
    assert.equal(repeated.scan.scanned, 0, "the pending delta is retried without rescanning sessions");
    assert.equal(readFileSync(tree.totalsPath, "utf-8"), frozenTotals);
  } finally {
    chmodSync(month, 0o600);
  }

  await scan(tree);
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 2);
  assert.equal(totalsOf(tree).families.claude.totalSessions, 1);
  assert.equal(monthOf(tree).days[localDayKey(Date.parse(tsForDay(-1)))].claude.slots[""].models["claude-opus-5-5"].messages, 2);
  assert.equal(readJson(tree.cachePath).pendingLate, undefined);
  const healed = totalsOf(tree);
  await scan(tree);
  assert.deepEqual(totalsOf(tree), healed, "a late delta is not applied twice");
});

test("a read-only reader never repairs a corrupt month file", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const month = resolveMonthPath(tree.historyDir, MONTH);
  writeFileSync(month, "{bad", "utf-8");
  mkdirSync(dirname(tree.cachePath), { recursive: true });
  writeFileSync(`${tree.cachePath}.lock`, "other-run\n", "utf-8");

  const blocked = await scan(tree);
  assert.equal(blocked.scan.locked, true);
  assert.ok(
    readdirSync(tree.historyDir).every((name) => !name.includes(".corrupt-")),
    "renaming a file aside is a repair, and this run does not own the lock (finding N10)",
  );
  assert.ok(
    blocked.warnings.some((warning) => warning.includes("does not hold the history lock")),
    blocked.warnings.join(" | "),
  );
  assert.equal(readFileSync(month, "utf-8"), "{bad", "the corrupt file is left exactly as it was");
});

test("a quarantined month says what was lost and where the copy is", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 400, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const month = resolveMonthPath(tree.historyDir, MONTH);
  const totalsBefore = readFileSync(tree.totalsPath, "utf-8");
  writeFileSync(month, "{truncated", "utf-8");

  const result = await scan(tree);
  const warning = result.warnings.find((entry) => entry.includes("corrupt or from another version"));
  assert.ok(warning, result.warnings.join(" | "));
  assert.match(warning, new RegExp(resolveMonthPath(tree.historyDir, MONTH).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(warning, /\.corrupt-\d+/, "the copy is named so it can be restored");
  assert.ok(readdirSync(tree.historyDir).some((name) => name.includes(".corrupt-")));
  // Frozen details are not reconstructed from surviving sessions.
  assert.equal(result.byFamily.claude.recentDays.at(-2).messageCount, 0);
  assert.equal(result.byFamily.claude.totalPrompts, 2, "the rollup still counts the rebuilt day, plus today");
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 1, "the rollup holds the frozen day only, never today");
  assert.equal(result.scan.frozenDays, 0);
  assert.equal(existsSync(resolveMonthPath(tree.historyDir, MONTH)), false, "the quarantined month is not recreated");
  assert.equal(readFileSync(tree.totalsPath, "utf-8"), totalsBefore, "the rollup is unchanged");
});

test("a deleted session cannot shrink a quarantined frozen day or a totals rebuild", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [assistantLine({ ts: tsForDay(-1) })]);
  const deleted = writeSession(tree.sessions, "b.jsonl", [assistantLine({ ts: tsForDay(-1) }), assistantLine({ ts: tsForDay(-1) })]);
  await scan(tree);
  const month = resolveMonthPath(tree.historyDir, MONTH);
  const totalsBefore = readFileSync(tree.totalsPath, "utf-8");
  const day = localDayKey(Date.parse(tsForDay(-1)));
  assert.equal(monthOf(tree).days[day].claude.slots[""].models["claude-opus-5-5"].messages, 3);

  unlinkSync(deleted);
  writeFileSync(month, "{bad", "utf-8");
  const result = await scan(tree);
  assert.equal(existsSync(month), false);
  assert.equal(result.byFamily.claude.recentDays.find((entry) => entry.date === day).messageCount, 0);
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 3, "the session deletion does not shrink totals.json");

  const rebuilt = rebuildTotalsFromMonths({ historyDir: tree.historyDir, warnings: [] });
  assert.equal(rebuilt.ok, false, "rebuild-totals refuses the incomplete month set");
  assert.match(rebuilt.error, /quarantined month history/);
  assert.equal(readFileSync(tree.totalsPath, "utf-8"), totalsBefore, "the refused rebuild leaves the rollup untouched");
});

test("a lost rollup is rebuilt from the month files, not from the surviving sessions", async () => {
  const tree = tempTree();
  const day = localDayKey(Date.parse(tsForDay(-1)));
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const second = writeSession(tree.sessions, "b.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  assert.equal(monthOf(tree).days[day].claude.slots[""].models["claude-opus-5-5"].messages, 3);

  // Losing totals.json *and* a session file used to make the rescan rewrite the
  // frozen day with only what still exists (3 -> 1) (review finding N3).
  unlinkSync(second);
  rmSync(tree.totalsPath, { force: true });
  const recovered = await scan(tree);

  assert.equal(
    monthOf(tree).days[day].claude.slots[""].models["claude-opus-5-5"].messages,
    3,
    "a frozen day is never rewritten from a rescan",
  );
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 3, "the rollup is rebuilt from the month file");
  assert.equal(totalsOf(tree).lastFrozenDay, day);
  assert.ok(recovered.warnings.some((warning) => warning.includes("rebuilt from")), recovered.warnings.join(" | "));
});

test("a forked session that diverges from its parent is still counted", async () => {
  const tree = tempTree();
  const first = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);

  // A fork copies the parent's lines and then appends its own: same head, a
  // different size and tail, so the copy fingerprint must not swallow it.
  writeSession(tree.sessions, "a-fork.jsonl", [
    ...readFileSync(first, "utf-8").trimEnd().split("\n"),
    assistantLine({ ts: tsForDay(0), usage: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const after = await scan(tree);
  // The fork's copied lines are counted again — the documented limitation: a
  // divergent file is not a byte-identical copy, and dropping its prefix would
  // also drop whatever it added. Only its *own* extra message is new.
  assert.equal(after.byFamily.claude.todayTotalTokens, 2_030, "the parent, the copied line, and the fork's own message");
  assert.equal(after.byFamily.claude.totalPrompts, 4);
  assert.equal(after.byFamily.claude.recentDays.at(-2).messageCount, 1_000, "the frozen day is not touched by the fork");
});

test("a renamed session file keeps its frozen day and is not counted twice", async () => {
  const tree = tempTree();
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const frozen = totalsOf(tree);
  const day = localDayKey(Date.parse(tsForDay(-1)));

  renameSync(file, join(tree.sessions, "a-renamed.jsonl"));
  const after = await scan(tree);
  assert.equal(after.byFamily.claude.totalPrompts, 2, "one frozen prompt plus today's, not two of each");
  assert.equal(after.byFamily.claude.todayTotalTokens, 1_000);
  assert.deepEqual(totalsOf(tree), frozen, "a move is not a new day of history");
  assert.equal(monthOf(tree).days[day].claude.slots[""].models["claude-opus-5-5"].input, 1_000);
  assert.deepEqual(Object.keys(readJson(tree.cachePath).files), [join(tree.sessions, "a-renamed.jsonl")]);
});

test("a same-size in-place rewrite is rescanned instead of read from the old offset", async () => {
  const tree = tempTree();
  const before = assistantLine({ usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const file = writeSession(tree.sessions, "a.jsonl", [before]);
  await scan(tree);
  assert.equal((await scan(tree)).scan.reused, 1, "an untouched file is reused");

  // Same byte length, different numbers, new mtime: truncate + rewrite. Reading
  // from the cached offset would return nothing and keep the stale numbers.
  const after = before.replace('"input":1000', '"input":7777');
  assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), "the rewrite must keep the size");
  writeFileSync(file, `${after}\n`, "utf-8");
  const result = await scan(tree);
  assert.equal(result.scan.reused, 0);
  assert.equal(result.byFamily.claude.todayTotalTokens, 7_777);
  assert.equal(result.byFamily.claude.todayPrompts, 1);
});

test("a late write to a frozen day reaches the seven-day window", async () => {
  const tree = tempTree();
  const yesterday = localDayKey(Date.parse(tsForDay(-1)));
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  assert.equal(monthOf(tree).days[yesterday].claude.slots[""].models["claude-opus-5-5"].input, 1_000);

  // A cache written before the freeze still holds the day as open, while the
  // month file has moved on. The window must trust the month file, or the day's
  // late write stays invisible for the whole week.
  const cache = readJson(tree.cachePath);
  cache.files[file].days = {
    [yesterday]: [["claude", "", "claude-opus-5-5", 1_000, 0, 0, 0, 1]],
  };
  writeFileSync(tree.cachePath, JSON.stringify(cache), "utf-8");
  appendSession(file, [assistantLine({ ts: tsForDay(-1), usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 } })]);

  const result = await scan(tree);
  assert.equal(result.byFamily.claude.recentDays.at(-2).date, yesterday);
  assert.equal(result.byFamily.claude.recentDays.at(-2).messageCount, 1_500, "the month file carries the late write");
  assert.equal(result.byFamily.claude.todayTotalTokens, 0);
  assert.equal(result.byFamily.claude.totalPrompts, 2, "the frozen message plus the late one, each once");
  assert.equal(monthOf(tree).days[yesterday].claude.slots[""].models["claude-opus-5-5"].input, 1_500);
});

test("two concurrent scans apply a late write exactly once", async () => {
  const tree = tempTree();
  const yesterday = localDayKey(Date.parse(tsForDay(-1)));
  const file = writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  appendSession(file, [assistantLine({ ts: tsForDay(-1), usage: { input: 5_000, output: 0, cacheRead: 0, cacheWrite: 0 } })]);

  // The systemd timer and /usage both fire; without the lock both would apply
  // the same late delta and the frozen day would gain 10 000.
  const [first, second] = await Promise.all([scan(tree), scan(tree)]);
  const model = monthOf(tree).days[yesterday].claude.slots[""].models["claude-opus-5-5"];
  assert.equal(model.input, 6_000, "the delta is applied once");
  assert.equal(model.messages, 2);
  assert.equal(totalsOf(tree).families.claude.modelUsage["claude-opus-5-5"].input, 6_000);
  assert.equal([first.scan.locked, second.scan.locked].filter(Boolean).length, 1, "exactly one run took the read-only path");
});

test("a run that cannot take the history lock reports from disk and writes nothing", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  const frozen = totalsOf(tree);
  const cacheBefore = readFileSync(tree.cachePath, "utf-8");

  // Another run holds the lock; this one must answer and touch nothing.
  const lockPath = `${tree.cachePath}.lock`;
  writeFileSync(lockPath, "999999\n", "utf-8");
  const blocked = await scan(tree);
  assert.equal(blocked.scan.locked, true);
  assert.equal(blocked.scan.scanned, 0);
  assert.equal(blocked.byFamily.claude.totalPrompts, first.byFamily.claude.totalPrompts, "the numbers still come from disk");
  assert.ok(blocked.warnings.some((warning) => warning.includes("another piquota run")), blocked.warnings.join(" | "));
  assert.deepEqual(totalsOf(tree), frozen);
  assert.equal(readFileSync(tree.cachePath, "utf-8"), cacheBefore);

  // A lock left behind by a killed run is reclaimed once it is old enough.
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath, old, old);
  const taken = await scan(tree);
  assert.equal(taken.scan.locked, false);
  assert.ok(!existsSync(lockPath), "the lock is released when the run ends");
});

test("rebuild-totals refuses to zero a rollup whose month files are gone", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const frozen = totalsOf(tree);
  const monthPath = resolveMonthPath(tree.historyDir, MONTH);
  rmSync(monthPath, { force: true });

  const warnings = [];
  const rebuilt = rebuildTotalsFromMonths({ historyDir: tree.historyDir, warnings });
  assert.equal(rebuilt.ok, false);
  assert.match(rebuilt.error, /refusing to replace it with an empty rollup/);
  assert.deepEqual(totalsOf(tree), frozen, "the existing rollup is left alone");

  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk) => {
    stderr += String(chunk);
    return true;
  };
  try {
    assert.equal(runStatsCommand({ rebuild: true, historyDir: tree.historyDir, cachePath: tree.cachePath }), 1);
  } finally {
    process.stderr.write = original;
  }
  assert.match(stderr, /could not rebuild the history totals/);
});

test("a lost rollup is rebuilt from the session files on the next scan", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 1);

  // What a rebuild over an empty month directory used to leave behind.
  writeJsonAtomic(tree.totalsPath, { schemaVersion: 1, lastFrozenDay: "", families: {} });
  const recovered = await scan(tree);
  assert.equal(recovered.scan.scanned, 1, "the cache still remembers frozen days, so the run rescans");
  assert.equal(recovered.byFamily.claude.totalPrompts, 1, "the day is frozen again from the session file");
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 1);
});

test("a fresh install with no closed days does not rescan on every run", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(0), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  assert.equal(first.scan.scanned, 1);
  assert.equal(totalsOf(tree).lastFrozenDay, "", "an empty rollup is written, nothing is frozen");

  const second = await scan(tree);
  assert.equal(second.scan.scanned, 0, "an empty rollup with no month files is not a lost history");
  assert.equal(second.scan.reused, 1);
  assert.equal(second.byFamily.claude.todayTotalTokens, 10);
});

test("a session that spans midnight counts one session-day per day", async () => {
  const tree = tempTree();
  const at = (day, hour) => {
    const [year, month, date] = day.split("-").map(Number);
    return new Date(year, month - 1, date, hour, 0, 0, 0).toISOString();
  };
  const yesterday = localDayKey(Date.parse(tsForDay(-1)));
  writeSession(tree.sessions, "spanning.jsonl", [
    assistantLine({ ts: at(yesterday, 23), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: at(TODAY, 1), usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const result = await scan(tree);
  // Documented semantics: session counts are session-days, because a day is
  // frozen without its session list.
  assert.equal(result.byFamily.claude.totalSessions, 2);
  assert.equal(result.byFamily.claude.todaySessions, 1);
  assert.equal(result.byFamily.claude.totalPrompts, 2);
});

test("history is partitioned by local month", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: new Date(noonOf("2026-01-31")).toISOString(), usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: new Date(noonOf("2026-02-01")).toISOString(), usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const result = await scan(tree, { now: noonOf("2026-02-02") });

  assert.ok(readdirSync(tree.historyDir).includes("tokens-2026-01.json"));
  assert.ok(readdirSync(tree.historyDir).includes("tokens-2026-02.json"));
  assert.deepEqual(Object.keys(readJson(resolveMonthPath(tree.historyDir, "2026-01")).days), ["2026-01-31"]);
  assert.deepEqual(Object.keys(readJson(resolveMonthPath(tree.historyDir, "2026-02")).days), ["2026-02-01"]);
  assert.equal(totalsOf(tree).lastFrozenDay, "2026-02-01");
  assert.equal(result.byFamily.claude.totalPrompts, 2);
  assert.equal(result.byFamily.claude.recentDays.find((day) => day.date === "2026-01-31").messageCount, 100);
  assert.equal(result.byFamily.claude.recentDays.find((day) => day.date === "2026-02-01").messageCount, 200);
});

test("all-time totals do not read old month files", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: new Date(noonOf("2026-08-15")).toISOString(), usage: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan(tree);
  assert.equal(first.byFamily.claude.totalPrompts, 2);
  assert.ok(readdirSync(tree.historyDir).includes("tokens-2026-08.json"));

  rmSync(resolveMonthPath(tree.historyDir, "2026-08"), { force: true });
  const second = await scan(tree);
  assert.equal(second.byFamily.claude.totalPrompts, 2, "the old day comes from totals, not from its month file");
  assert.equal(second.byFamily.claude.modelUsage["claude-opus-5-5"].inputTokens, 310);
});

test("a crash between the month write and the totals write re-freezes the day exactly once", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(0), usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  // Leave the day open in the cache (a scan at "today" never freezes it), then
  // simulate the half-written state: month file present, totals still empty.
  await scan(tree);
  writeJsonAtomic(resolveMonthPath(tree.historyDir, MONTH), {
    schemaVersion: 1,
    month: MONTH,
    days: { [TODAY]: { claude: { sessions: 1, slots: { "": { sessions: 1, models: { "claude-opus-5-5": { input: 40, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } } } } } } },
  });
  writeJsonAtomic(tree.totalsPath, { schemaVersion: 1, lastFrozenDay: "", families: {} });

  const tomorrow = Date.parse(tsForDay(1));
  const result = await scan(tree, { now: tomorrow });
  // The rollup was empty while a month file existed, so the run restores the
  // rollup *from that month file* instead of re-freezing from the session file.
  assert.equal(result.scan.frozenDays, 0, "the day was already frozen; nothing to freeze again");
  assert.ok(result.warnings.some((warning) => warning.includes("rebuilt from")), result.warnings.join(" | "));
  assert.equal(totalsOf(tree).families.claude.totalPrompts, 1, "the re-freeze is a SET, not a second add");
  assert.equal(totalsOf(tree).families.claude.modelUsage["claude-opus-5-5"].input, 40);
  assert.equal(totalsOf(tree).lastFrozenDay, TODAY);

  const once = totalsOf(tree);
  await scan(tree, { now: tomorrow });
  assert.deepEqual(totalsOf(tree), once);
});

test("rebuild-totals from the month files equals the incremental totals", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-3), provider: "anthropic", usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(-1), provider: "opencode-go-2", usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: tsForDay(0), provider: "anthropic", usage: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);
  const incremental = totalsOf(tree);
  assert.ok(incremental.families.claude);
  assert.ok(incremental.families["opencode-go"]);

  const warnings = [];
  const rebuilt = rebuildTotalsFromMonths({ historyDir: tree.historyDir, warnings });
  assert.equal(rebuilt.ok, true, rebuilt.error);
  assert.deepEqual(warnings, []);
  assert.deepEqual(totalsOf(tree), incremental);

  const loaded = loadTotals({ historyDir: tree.historyDir, warnings: [] });
  assert.equal(loaded.rescanAll, false);
  assert.equal(loaded.totals.families.get("opencode-go").totalPrompts, 1);
});

test("the stats command rebuilds the totals and reports it", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  await scan(tree);

  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    assert.equal(runStatsCommand({ rebuild: true, historyDir: tree.historyDir }), 0);
  } finally {
    process.stdout.write = original;
  }
  assert.match(output, /rebuilt .*totals\.json/);
  assert.match(output, /1 frozen day\(s\)/);
});

test("a budget-truncated scan does not freeze an incomplete day", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: tsForDay(-1), usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);

  const partial = await collectLocalStats({
    roots: [tree.sessions],
    cachePath: tree.cachePath,
    historyDir: tree.historyDir,
    now: NOW,
    budgetMs: -1,
  });
  assert.equal(partial.scan.partial, true);
  assert.equal(partial.scan.frozenDays, 0);
  assert.deepEqual(partial.byFamily, {});
  assert.ok(!readdirSync(tree.historyDir).some((name) => name.startsWith("tokens-")), "nothing was frozen");

  const full = await scan(tree);
  assert.equal(full.scan.frozenDays, 1);
  assert.equal(full.byFamily.claude.totalPrompts, 1);
  assert.ok(readdirSync(tree.historyDir).some((name) => name.startsWith("tokens-")));
});

test("a budget that expires mid-file keeps the bytes it read and resumes there", async () => {
  const tree = tempTree();
  const lines = [];
  for (let index = 0; index < 20_000; index += 1) {
    lines.push(assistantLine({ usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  }
  const file = writeSession(tree.sessions, "big.jsonl", lines);

  // The scan reads the clock a fixed number of times before it starts parsing
  // (start, meta, lock, loop top); the 16384-line check inside readLines is the
  // one that must run out. If that count ever changes the test fails loudly on
  // the "stopped inside the file" assertion below.
  let reads = 0;
  const clock = () => (reads++ < 5 ? 0 : 1_000_000);
  const partial = await collectLocalStats({
    roots: [tree.sessions],
    cachePath: tree.cachePath,
    historyDir: tree.historyDir,
    now: NOW,
    budgetMs: 5_000,
    clock,
  });
  assert.equal(partial.scan.partial, true);
  assert.equal(partial.scan.scanned, 1);
  assert.ok(
    partial.byFamily.claude.totalPrompts > 0 && partial.byFamily.claude.totalPrompts < 20_000,
    `the budget must stop inside the file, not before it (read ${partial.byFamily.claude?.totalPrompts ?? 0} lines)`,
  );

  const full = await scan(tree);
  assert.equal(full.scan.partial, false);
  assert.equal(full.byFamily.claude.totalPrompts, 20_000, "the second run resumes where the budget stopped");
  assert.ok(full.scan.bytesRead < statSync(file).size, "the completed prefix is not read again");
});

test("the scan cache is written atomically with private permissions", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [assistantLine()]);
  await scan(tree);
  assert.equal(statSync(tree.cachePath).mode & 0o777, 0o600);
  const envelope = readJson(tree.cachePath);
  assert.equal(envelope.schemaVersion, 2);
  const [entry] = Object.values(envelope.files);
  assert.equal(typeof entry.size, "number");
  assert.equal(typeof entry.mtimeMs, "number");
  assert.equal(typeof entry.offset, "number");
  assert.equal(entry.complete, true);
  assert.equal(entry.offset, entry.size, "a file ending in a newline is fully consumed");
  assert.equal(statSync(tree.totalsPath).mode & 0o777, 0o600);
});

test("session roots honour PI_CODING_AGENT_DIR and only include existing directories", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-roots-"));
  mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
  mkdirSync(join(home, ".omp", "agent", "sessions"), { recursive: true });
  const agentDir = join(home, "custom-agent");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });

  assert.deepEqual(resolveSessionRoots({ env: { PI_CODING_AGENT_DIR: agentDir }, home }), [
    join(agentDir, "sessions"),
    join(home, ".pi", "agent", "sessions"),
    join(home, ".omp", "agent", "sessions"),
  ]);

  const aliasAgent = join(home, "agent-alias");
  symlinkSync(join(home, ".pi", "agent"), aliasAgent);
  assert.deepEqual(resolveSessionRoots({ env: { PI_CODING_AGENT_DIR: aliasAgent }, home }), [
    join(aliasAgent, "sessions"),
    join(home, ".omp", "agent", "sessions"),
  ], "a symlinked agent dir does not add the same sessions twice");

  const bare = mkdtempSync(join(tmpdir(), "pi-quota-roots-empty-"));
  assert.deepEqual(resolveSessionRoots({ env: {}, home: bare }), []);
  assert.equal(
    resolveLocalStatsCachePath({ env: { XDG_CACHE_HOME: join(home, "cache") }, home }),
    join(home, "cache", "pi-quota", "local-sessions.json"),
  );
  assert.equal(
    resolveHistoryDir({ env: { PI_CODING_AGENT_DIR: agentDir }, home }),
    join(agentDir, "pi-usage"),
    "history lives with the agent directory",
  );
  assert.equal(resolveHistoryDir({ env: {}, home }), join(home, ".pi", "agent", "pi-usage"));
  assert.equal(resolveTotalsPath(treePath(agentDir)), join(agentDir, "pi-usage", "totals.json"));
});

/** Build a history dir without touching the filesystem (path helpers only). */
function treePath(agentDir) {
  return join(agentDir, "pi-usage");
}

test("Omarchy records carry the local stats fields and keep their quota fields", () => {
  const report = { providers: [provider()], localStats: { claude: LOCAL } };
  const records = buildRecords(report, { now: NOW });
  assert.equal(records.length, 1);
  const record = records[0].record;

  assert.equal(records[0].id, "pi-claude");
  assert.deepEqual(record.limits, [
    { label: "5h window", title: "Session", percent: 0.25, resetsAt: "" },
  ]);
  assert.equal(record.hasLocalStats, true);
  assert.equal(record.hasPromptStats, true);
  assert.equal(record.todayPrompts, 12);
  assert.equal(record.todaySessions, 2);
  assert.equal(record.todayTotalTokens, 34_567);
  assert.deepEqual(record.todayTokensByModel, { "claude-opus-5-5": 30_000, "claude-sonnet-5": 4_567 });
  assert.equal(record.recentDays.length, 7);
  assert.deepEqual(record.recentDays.at(-1), { date: "2026-11-02", messageCount: 34_567 });
  assert.equal(record.totalPrompts, 99);
  assert.equal(record.totalSessions, 7);
  assert.equal(record.activeDays, 4);
  assert.deepEqual(record.activeDates, LOCAL.activeDates);
  assert.deepEqual(record.modelUsage["claude-opus-5-5"], LOCAL.modelUsage["claude-opus-5-5"]);
  assert.equal("byAccount" in record, false, "the Omarchy record stays Omarchy-shaped");
});

test("a family with local usage but no credential gets no record", () => {
  const report = {
    providers: [provider({ family: "codex", label: "Codex (Pi)" })],
    localStats: { claude: LOCAL },
  };
  const records = buildRecords(report, { now: NOW });
  assert.deepEqual(records.map((built) => built.id), ["pi-codex"]);
  assert.equal(records[0].record.hasLocalStats, false);
});

test("collectQuota attaches localStats and its meta block next to the quota results", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [
    assistantLine({ ts: new Date(NOW).toISOString(), usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const { fetchFn } = routedFetch([["api.anthropic.com", () => jsonResponse(claudeUsageBody())]]);
  const home = mkdtempSync(join(tmpdir(), "pi-quota-local-engine-"));

  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["claude"],
    env: {},
    home,
    stores: [],
    allowBrowser: false,
    localStats: { roots: [tree.sessions], cachePath: tree.cachePath, historyDir: tree.historyDir, budgetMs: 60_000 },
  });

  assert.equal(report.providers[0].ok, true, "local stats never change a provider result");
  assert.equal(report.localStats.claude.todayTotalTokens, 100);
  assert.equal(report.localStats.claude.todayPrompts, 1);
  assert.equal(report.localStatsMeta.files, 1);
  assert.equal(report.localStatsMeta.scanned, 1);
  assert.equal(report.localStatsMeta.partial, false);
  assert.equal(report.localStatsMeta.frozenDays, 0);
});

test("a local-stats cache failure is a warning, never a provider failure", async () => {
  const tree = tempTree();
  writeSession(tree.sessions, "a.jsonl", [assistantLine({ usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  // A directory where the cache file should be makes the atomic rename fail.
  const cachePath = join(tree.dir, "blocked-cache");
  mkdirSync(cachePath, { recursive: true });
  const { fetchFn } = routedFetch([["api.anthropic.com", () => jsonResponse(claudeUsageBody())]]);
  const home = mkdtempSync(join(tmpdir(), "pi-quota-local-engine-"));

  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["claude"],
    env: {},
    home,
    stores: [],
    allowBrowser: false,
    localStats: { roots: [tree.sessions], cachePath, historyDir: tree.historyDir, budgetMs: 60_000 },
  });

  assert.equal(report.providers[0].ok, true);
  assert.equal(report.localStats.claude.todayTotalTokens, 5);
  assert.ok(
    report.warnings.some((warning) => warning.includes("could not write the scan cache")),
    report.warnings.join(" | "),
  );
});

test("local stats stay off unless a caller asks for them", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-local-off-"));
  const { fetchFn } = routedFetch([["api.anthropic.com", () => jsonResponse(claudeUsageBody())]]);
  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["claude"],
    env: {},
    home,
    stores: [],
    allowBrowser: false,
  });
  assert.deepEqual(report.localStats, {});
  assert.equal(report.localStatsMeta, null);
});

test("a local calendar day is computed in local time, not UTC", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    // 20:00 UTC is already the next day in Tokyo.
    assert.equal(localDayKey(Date.parse("2026-11-02T20:00:00.000Z")), "2026-11-03");
    process.env.TZ = "America/Los_Angeles";
    // 02:00 UTC is still the previous day in Los Angeles.
    assert.equal(localDayKey(Date.parse("2026-11-03T02:00:00.000Z")), "2026-11-02");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("a message with only totalTokens is counted instead of dropped", () => {
  const usage = usageFromLine(
    JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic", model: "m", usage: { totalTokens: 77 } } }),
    NOW,
  );
  assert.deepEqual(usage, {
    day: TODAY,
    family: "claude",
    slot: "",
    model: "m",
    input: 77,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});
