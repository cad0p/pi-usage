/**
 * Local token statistics tests.
 *
 * Every scan runs against a synthetic session tree in a temp directory with its
 * own cache path: no test reads the real Pi store or writes outside its fixture.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectQuota } from "../src/engine.js";
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

let entrySequence = 0;

/** One JSONL assistant message, exactly as Pi writes it. */
function assistantLine(input = {}) {
  entrySequence += 1;
  const usage = input.usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  return JSON.stringify({
    type: "message",
    id: `entry-${entrySequence}`,
    timestamp: input.ts ?? "2026-11-02T10:00:00.000Z",
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
  return { dir, sessions, cachePath: join(dir, "cache", "local-sessions.json") };
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

function scan(options) {
  return collectLocalStats({ now: NOW, budgetMs: 60_000, ...options });
}

/** Synthetic local stats, shaped like the builder's output. */
const LOCAL = {
  hasLocalStats: true,
  hasPromptStats: true,
  todayPrompts: 12,
  todaySessions: 2,
  todayTotalTokens: 34_567,
  todayTokensByModel: { "claude-opus-5-5": 30_000, "claude-sonnet-5": 4_567 },
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
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "--work--/a.jsonl", [
    assistantLine({ provider: "anthropic", model: "claude-opus-5-5", usage: { input: 4, output: 425, cacheRead: 6838, cacheWrite: 6905, totalTokens: 14172 } }),
    assistantLine({ provider: "opencode-go-7", model: "deepseek-v4.1-flash", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } }),
    assistantLine({ provider: "deepinfra", model: "deepseek-ai/DeepSeek", usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1998 } }),
    assistantLine({ provider: "claude-bridge", model: "claude-opus-5-5", usage: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 999 } }),
  ]);

  const result = await scan({ roots: [sessions], cachePath });

  assert.deepEqual(Object.keys(result.byFamily).sort(), ["claude", "opencode-go"]);
  assert.equal(result.byFamily.claude.todayTotalTokens, 14_172);
  assert.equal(result.byFamily.claude.todayPrompts, 1);
  assert.deepEqual(result.byFamily.claude.todayTokensByModel, { "claude-opus-5-5": 14_172 });
  assert.deepEqual(Object.keys(result.byFamily["opencode-go"].byAccount), ["#7"]);
  assert.equal(result.byFamily["opencode-go"].byAccount["#7"].todayTokens, 110);
  assert.equal(result.byFamily.claude.recentDays.at(-1).date, localDayKey(NOW));
  assert.equal(result.byFamily.claude.recentDays.length, 7);
});

test("the api field identifies the family when the provider field is missing", async () => {
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "a.jsonl", [
    assistantLine({ provider: null, api: "openai-codex-responses", model: "gpt-5.1-codex", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 } }),
  ]);
  const result = await scan({ roots: [sessions], cachePath });
  assert.deepEqual(Object.keys(result.byFamily), ["codex"]);
  assert.equal(result.byFamily.codex.todayTotalTokens, 10);
});

test("assistant messages without any token count are not prompts", async () => {
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "a.jsonl", [
    assistantLine({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }),
    assistantLine({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const result = await scan({ roots: [sessions], cachePath });
  assert.deepEqual(result.byFamily, {});
});

test("usageFromLine rejects malformed lines, other roles and non-message entries", () => {
  assert.equal(usageFromLine("not json", NOW), null);
  assert.equal(usageFromLine(JSON.stringify({ type: "message", message: { role: "user", provider: "anthropic", usage: { input: 1 } } }), NOW), null);
  assert.equal(usageFromLine(JSON.stringify({ type: "custom", message: { role: "assistant", provider: "anthropic", usage: { input: 1 } } }), NOW), null);
  assert.equal(usageFromLine(JSON.stringify({ type: "message", message: { role: "assistant", provider: "anthropic" } }), NOW), null);
});

test("the base account is #1 and siblings sort numerically", async () => {
  const { sessions, cachePath } = tempTree();
  const today = "2026-11-02T10:00:00.000Z";
  const yesterday = "2026-11-01T10:00:00.000Z";
  const old = "2026-10-20T10:00:00.000Z";
  writeSession(sessions, "a.jsonl", [
    assistantLine({ ts: today, provider: "opencode-go", usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: today, provider: "opencode-go-2", usage: { input: 22, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: today, provider: "opencode-go-10", usage: { input: 110, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: yesterday, provider: "opencode-go-7", usage: { input: 70, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ ts: old, provider: "opencode-go-2", usage: { input: 5_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);

  const result = await scan({ roots: [sessions], cachePath });
  const stats = result.byFamily["opencode-go"];

  assert.deepEqual(Object.keys(stats.byAccount), ["#1", "#2", "#7", "#10"]);
  assert.equal(stats.byAccount["#1"].todayTokens, 11);
  assert.equal(stats.byAccount["#2"].todayTokens, 22);
  assert.equal(stats.byAccount["#2"].weekTokens, 22, "the 20-day-old message is outside the 7-day window");
  assert.equal(stats.byAccount["#2"].totalTokens, 5_022);
  assert.equal(stats.byAccount["#7"].todayTokens, 0);
  assert.equal(stats.byAccount["#7"].weekTokens, 70);
  assert.equal(stats.byAccount["#10"].todayTokens, 110);
  assert.equal(stats.byAccount["#10"].todayPrompts, 1);
  assert.equal(stats.todayTotalTokens, 143);
  assert.equal(stats.totalPrompts, 5);
  assert.deepEqual(stats.weekTokensByModel, { "claude-opus-5-5": 213 }, "the 20-day-old message is outside the weekly per-model totals");
});

test("a grown session file is read from its last complete line", async () => {
  const { sessions, cachePath } = tempTree();
  const file = writeSession(sessions, "a.jsonl", [
    assistantLine({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan({ roots: [sessions], cachePath });
  assert.equal(first.scan.scanned, 1);
  assert.equal(first.scan.bytesRead, statSync(file).size);
  assert.equal(first.byFamily.claude.todayTotalTokens, 10);

  const appended = assistantLine({ usage: { input: 25, output: 0, cacheRead: 0, cacheWrite: 0 } });
  appendSession(file, [appended]);

  const second = await scan({ roots: [sessions], cachePath });
  assert.equal(second.scan.scanned, 1);
  assert.equal(second.scan.reused, 0);
  assert.equal(second.scan.bytesRead, Buffer.byteLength(appended) + 1, "only the appended line is read");
  assert.equal(second.byFamily.claude.todayTotalTokens, 35);
  assert.equal(second.byFamily.claude.todayPrompts, 2);

  const third = await scan({ roots: [sessions], cachePath });
  assert.equal(third.scan.reused, 1);
  assert.equal(third.scan.bytesRead, 0);
  assert.equal(third.byFamily.claude.todayTotalTokens, 35);
});

test("an unterminated last line is counted once it is completed", async () => {
  const { sessions, cachePath } = tempTree();
  const file = join(sessions, "a.jsonl");
  const complete = assistantLine({ usage: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const partial = assistantLine({ usage: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0 } });
  writeFileSync(file, `${assistantLine({ usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } })}\n${partial.slice(0, 40)}`, "utf-8");

  const first = await scan({ roots: [sessions], cachePath });
  assert.equal(first.byFamily.claude.todayPrompts, 1, "the half-written line is not counted yet");

  writeFileSync(file, `${assistantLine({ usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 } })}\n${complete}\n${partial}\n`, "utf-8");
  const second = await scan({ roots: [sessions], cachePath });
  // The rewrite shares the prefix, so the resumed read starts at the old
  // partial line and sees both new messages exactly once.
  assert.equal(second.byFamily.claude.todayPrompts, 3);
});

test("a session file that shrank is rescanned from zero", async () => {
  const { sessions, cachePath } = tempTree();
  const file = writeSession(sessions, "a.jsonl", [
    assistantLine({ usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistantLine({ usage: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan({ roots: [sessions], cachePath });
  assert.equal(first.byFamily.claude.todayTotalTokens, 1_000);
  assert.equal(first.byFamily.claude.totalSessions, 1);

  writeSession(sessions, "a.jsonl", [assistantLine({ usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  const second = await scan({ roots: [sessions], cachePath });
  assert.ok(statSync(file).size < first.scan.bytesRead);
  assert.equal(second.byFamily.claude.todayTotalTokens, 7);
  assert.equal(second.byFamily.claude.todayPrompts, 1);
  assert.equal(second.byFamily.claude.totalPrompts, 1);
});

test("a deleted session file takes its contribution with it", async () => {
  const { sessions, cachePath } = tempTree();
  const kept = writeSession(sessions, "kept.jsonl", [assistantLine({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  const removed = writeSession(sessions, "removed.jsonl", [assistantLine({ usage: { input: 90, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  const first = await scan({ roots: [sessions], cachePath });
  assert.equal(first.byFamily.claude.todayTotalTokens, 100);
  assert.equal(first.byFamily.claude.totalSessions, 2);
  assert.equal(first.byFamily.claude.todaySessions, 2);

  unlinkSync(removed);
  const second = await scan({ roots: [sessions], cachePath });
  assert.equal(second.byFamily.claude.todayTotalTokens, 10);
  assert.equal(second.byFamily.claude.totalSessions, 1);
  assert.equal(second.byFamily.claude.todaySessions, 1);

  const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
  assert.deepEqual(Object.keys(cached.files), [kept]);
});

test("today is recomputed from the per-day aggregates when the clock moves on", async () => {
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "a.jsonl", [
    assistantLine({ ts: "2026-11-02T10:00:00.000Z", usage: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  ]);
  const first = await scan({ roots: [sessions], cachePath });
  assert.equal(first.byFamily.claude.todayTotalTokens, 30);
  assert.equal(first.byFamily.claude.totalPrompts, 1);

  const tomorrow = Date.parse("2026-11-03T09:00:00.000Z");
  const second = await collectLocalStats({ roots: [sessions], cachePath, now: tomorrow, budgetMs: 60_000 });
  assert.equal(second.scan.reused, 1, "the file did not change, so no bytes are re-read");
  assert.equal(second.byFamily.claude.todayTotalTokens, 0);
  assert.equal(second.byFamily.claude.todayPrompts, 0);
  assert.equal(second.byFamily.claude.totalPrompts, 1, "history is intact");
  assert.equal(second.byFamily.claude.recentDays.at(-1).date, localDayKey(tomorrow));
  assert.equal(second.byFamily.claude.recentDays.at(-2).messageCount, 30, "yesterday keeps its tokens");
});

test("the scan budget returns partial numbers and flags them", async () => {
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "a.jsonl", [assistantLine()]);
  writeSession(sessions, "b.jsonl", [assistantLine()]);

  const partial = await collectLocalStats({ roots: [sessions], cachePath, now: NOW, budgetMs: -1 });
  assert.equal(partial.scan.partial, true);
  assert.equal(partial.scan.scanned, 0);
  assert.equal(partial.scan.files, 2);
  assert.equal(partial.scan.budgetMs, -1);
  assert.deepEqual(partial.byFamily, {});

  const full = await scan({ roots: [sessions], cachePath });
  assert.equal(full.scan.partial, false);
  assert.equal(full.scan.scanned, 2);
  assert.equal(full.byFamily.claude.todayPrompts, 2);
});

test("a budget that expires mid-file keeps the bytes it read and resumes there", async () => {
  const { sessions, cachePath } = tempTree();
  const lines = [];
  for (let index = 0; index < 20_000; index += 1) {
    lines.push(assistantLine({ usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  }
  const file = writeSession(sessions, "big.jsonl", lines);

  // Three clock reads fit the budget (start, initial check, first file); the
  // 16384-line check inside readLines is the one that runs out.
  let reads = 0;
  const clock = () => (reads++ < 3 ? 0 : 1_000_000);
  const partial = await collectLocalStats({ roots: [sessions], cachePath, now: NOW, budgetMs: 5_000, clock });
  assert.equal(partial.scan.partial, true);
  assert.equal(partial.byFamily.claude.totalPrompts, 16_384);
  assert.equal(partial.scan.scanned, 1);

  const full = await scan({ roots: [sessions], cachePath });
  assert.equal(full.scan.partial, false);
  assert.equal(full.byFamily.claude.totalPrompts, 20_000, "the second run resumes where the budget stopped");
  assert.ok(full.scan.bytesRead < statSync(file).size, "the completed prefix is not read again");
});

test("a corrupt or foreign cache is a cache miss, not a failure", async () => {
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "a.jsonl", [assistantLine({ usage: { input: 12, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, "{not json", "utf-8");

  const first = await scan({ roots: [sessions], cachePath });
  assert.equal(first.byFamily.claude.todayTotalTokens, 12);
  assert.equal(first.scan.scanned, 1);
  const rewritten = JSON.parse(readFileSync(cachePath, "utf-8"));
  assert.equal(rewritten.schemaVersion, 1);
  assert.deepEqual(Object.keys(rewritten.files), [join(sessions, "a.jsonl")]);

  writeFileSync(cachePath, JSON.stringify({ schemaVersion: 99, files: {} }), "utf-8");
  const second = await scan({ roots: [sessions], cachePath });
  assert.equal(second.byFamily.claude.todayTotalTokens, 12);
  assert.equal(second.scan.scanned, 1, "a foreign schema version is rescanned");
});

test("the scan cache is written atomically with private permissions", async () => {
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "a.jsonl", [assistantLine()]);
  await scan({ roots: [sessions], cachePath });
  assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  const envelope = JSON.parse(readFileSync(cachePath, "utf-8"));
  assert.equal(envelope.schemaVersion, 1);
  const [entry] = Object.values(envelope.files);
  assert.equal(typeof entry.size, "number");
  assert.equal(typeof entry.mtimeMs, "number");
  assert.equal(typeof entry.offset, "number");
  assert.equal(entry.complete, true);
  assert.equal(entry.offset, entry.size, "a file ending in a newline is fully consumed");
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

  const bare = mkdtempSync(join(tmpdir(), "pi-quota-roots-empty-"));
  assert.deepEqual(resolveSessionRoots({ env: {}, home: bare }), []);
  assert.equal(
    resolveLocalStatsCachePath({ env: { XDG_CACHE_HOME: join(home, "cache") }, home }),
    join(home, "cache", "pi-quota", "local-sessions.json"),
  );
});

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
  const { sessions, cachePath } = tempTree();
  writeSession(sessions, "a.jsonl", [
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
    localStats: { roots: [sessions], cachePath, budgetMs: 60_000 },
  });

  assert.equal(report.providers[0].ok, true, "local stats never change a provider result");
  assert.equal(report.localStats.claude.todayTotalTokens, 100);
  assert.equal(report.localStats.claude.todayPrompts, 1);
  assert.equal(report.localStatsMeta.files, 1);
  assert.equal(report.localStatsMeta.scanned, 1);
  assert.equal(report.localStatsMeta.partial, false);
});

test("a local-stats cache failure is a warning, never a provider failure", async () => {
  const { dir, sessions } = tempTree();
  writeSession(sessions, "a.jsonl", [assistantLine({ usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  // A directory where the cache file should be makes the atomic rename fail.
  const cachePath = join(dir, "blocked-cache");
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
    localStats: { roots: [sessions], cachePath, budgetMs: 60_000 },
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
    day: localDayKey(NOW),
    family: "claude",
    slot: "",
    model: "m",
    input: 77,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("a removed session root removes its contribution on the next scan", async () => {
  const { dir, sessions, cachePath } = tempTree();
  const other = join(dir, "other-sessions");
  mkdirSync(other, { recursive: true });
  writeSession(sessions, "a.jsonl", [assistantLine({ usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  writeSession(other, "b.jsonl", [assistantLine({ usage: { input: 8, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
  const first = await scan({ roots: [sessions, other], cachePath });
  assert.equal(first.byFamily.claude.todayTotalTokens, 11);

  rmSync(other, { recursive: true, force: true });
  const second = await scan({ roots: [sessions, other], cachePath });
  assert.equal(second.byFamily.claude.todayTotalTokens, 3);
  assert.equal(second.scan.files, 1);
});
