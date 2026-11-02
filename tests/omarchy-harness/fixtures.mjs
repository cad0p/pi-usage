#!/usr/bin/env node
/**
 * Fixture usage records for the Omarchy plugin harness.
 *
 * pi-*.json come from the real record builder fed a synthetic report, so the
 * harness draws exactly what `piquota omarchy` would publish; claude.json
 * mimics Omarchy's own collector with local token statistics, and
 * fireworks.json is an unavailable record the panel must hide. Reset times and
 * days are relative to now, so countdowns stay meaningful.
 *
 * Usage: node tests/omarchy-harness/fixtures.mjs <out-dir>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildRecords } from "../../src/omarchy/record.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: fixtures.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms) => new Date(now + ms).toISOString();

const window = (id, usedPercent, resetIn) => ({
  id,
  label: { "5h": "5h window", weekly: "Weekly window", monthly: "Monthly window" }[id],
  usedPercent,
  remainingPercent: 100 - usedPercent,
  resetsAt: resetIn === null ? null : at(resetIn),
});

const go = (slot, windows, error = null) => ({
  family: "opencode-go",
  label: "OpenCode Go (Pi)",
  account: `#${slot}`,
  slot: slot === 1 ? null : String(slot),
  plan: "Go plan",
  ok: error === null,
  error,
  windows: error === null ? windows : [],
});

const goUsage = [
  [0, 0, 100],
  [0, 10, 90],
  [2, 11, 55],
  [2, 10, 55],
  [1, 11, 55],
  [1, 10, 55],
  [0, 8, 24],
];

const report = {
  providers: [
    {
      family: "claude",
      label: "Claude (Pi)",
      plan: "",
      ok: true,
      error: null,
      windows: [window("5h", 3, 3 * HOUR + 20 * MIN), window("weekly", 20, 3 * DAY + 2 * HOUR)],
    },
    {
      family: "codex",
      label: "Codex (Pi)",
      plan: "free",
      ok: true,
      error: null,
      windows: [window("monthly", 34, 29 * DAY + 19 * HOUR)],
    },
    {
      family: "antigravity",
      label: "Antigravity (Pi)",
      ok: false,
      error: "Antigravity token expired or rejected; /login antigravity",
      windows: [],
    },
    ...goUsage.map(([session, week, month], index) =>
      go(index + 1, [
        window("5h", session, 10 * MIN + index * 37 * MIN),
        window("weekly", week, 6 * DAY + 1 * HOUR),
        window("monthly", month, 18 * DAY + index * DAY),
      ]),
    ),
    ...[8, 9, 10].map((slot) => go(slot, [], "OpenCode Go key rejected (401); reconnect that account in Pi")),
    ...[11, 12, 13, 14].map((slot) => go(slot, [], "Go plan not active for this key's workspace (403 Workspace access denied)")),
  ],
};

for (const { id, record } of buildRecords(report, { now })) {
  writeFileSync(join(out, `${id}.json`), `${JSON.stringify(record, null, 1)}\n`);
}

const day = (offset) => {
  const date = new Date(now - offset * DAY);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const tokens = [18.2e6, 9.4e6, 0, 22.7e6, 31.1e6, 14.9e6, 12.3e6];

writeFileSync(
  join(out, "claude.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    id: "claude",
    name: "Claude Code",
    updatedAt: at(-2 * MIN),
    ready: true,
    tierLabel: "max 20x",
    usageStatusText: "",
    authHelpText: "",
    limits: [
      { label: "Session (5-hour)", title: "Session", percent: 0.42, resetsAt: at(2 * HOUR + 5 * MIN) },
      { label: "Weekly (7-day)", title: "Weekly", percent: 0.93, resetsAt: at(1 * DAY + 4 * HOUR) },
      { label: "Opus 5 (1M context)", title: "Opus weekly", percent: 0.61, resetsAt: at(1 * DAY + 4 * HOUR) },
    ],
    hasLocalStats: true,
    hasPromptStats: true,
    todayPrompts: 184,
    todaySessions: 7,
    todayTotalTokens: tokens[6],
    todayTokensByModel: { "claude-opus-4-8": 9.1e6, "claude-sonnet-4-6": 3.2e6 },
    recentDays: tokens.map((messageCount, index) => ({ date: day(6 - index), messageCount })),
    totalPrompts: 9120,
    totalSessions: 412,
    activeDays: 58,
    activeDates: [day(0), day(1), day(3)],
    modelUsage: {
      "claude-opus-4-8": { inputTokens: 2.1e6, outputTokens: 4.4e6, cacheReadInputTokens: 310e6, cacheCreationInputTokens: 21e6 },
      "claude-sonnet-4-6": { inputTokens: 1.2e6, outputTokens: 2.9e6, cacheReadInputTokens: 120e6, cacheCreationInputTokens: 9e6 },
      "claude-haiku-4-5-20251001": { inputTokens: 0.4e6, outputTokens: 0.3e6, cacheReadInputTokens: 8e6, cacheCreationInputTokens: 0.9e6 },
      "gpt-5.6-sol": { inputTokens: 0.2e6, outputTokens: 0.1e6, cacheReadInputTokens: 1e6, cacheCreationInputTokens: 0 },
    },
  })}\n`,
);

writeFileSync(
  join(out, "fireworks.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    id: "fireworks",
    name: "Fireworks",
    ready: false,
    hasLocalStats: false,
    tierLabel: "Prepaid",
    usageStatusText: "Fireworks unavailable",
    authHelpText: "Set FIREWORKS_API_KEY.",
    todayPrompts: 0,
    totalPrompts: 0,
    totalSessions: 0,
    activeDays: 0,
  })}\n`,
);
