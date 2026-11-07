/**
 * `piquota stats --json`: the read-only history feed.
 *
 * The command is what the /usage History page reads, so it must never take the
 * writer lock, never write, and stay usable while a scan is freezing days. The
 * tests run against a synthetic history tree and assert the exact JSON, the
 * notes for damaged files, and that nothing on disk changed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { historyJson, runStatsCommand } from "../src/cli/commands/stats.js";

function tempHistory() {
  const root = mkdtempSync(join(tmpdir(), "pi-quota-stats-json-"));
  const dir = join(root, "pi-usage");
  const cachePath = join(root, "cache", "local-sessions.json");
  mkdirSync(join(root, "cache"), { recursive: true });
  return { root, dir, cachePath };
}

function bucket(input, messages = 0) {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, messages };
}

const TOTALS = {
  schemaVersion: 1,
  lastFrozenDay: "2026-10-02",
  families: {
    claude: {
      firstDay: "2026-10-01",
      activeDates: ["2026-10-01", "2026-10-02"],
      totalPrompts: 6,
      totalSessions: 2,
      modelUsage: { "claude-opus-5-5": bucket(2_000, 6) },
      accounts: {
        "": { totalPrompts: 6, totalSessions: 2, modelUsage: { "claude-opus-5-5": bucket(2_000, 6) } },
      },
    },
    "opencode-go": {
      firstDay: "2026-10-01",
      activeDates: ["2026-10-01"],
      totalPrompts: 6,
      totalSessions: 1,
      modelUsage: { "deepseek-v4.1-flash": bucket(3_000, 6) },
      accounts: {
        "": { totalPrompts: 2, totalSessions: 1, modelUsage: { "deepseek-v4.1-flash": bucket(1_000, 2) } },
        "#2": { totalPrompts: 4, totalSessions: 1, modelUsage: { "deepseek-v4.1-flash": bucket(2_000, 4) } },
      },
    },
  },
};

const OCTOBER = {
  schemaVersion: 1,
  month: "2026-10",
  days: {
    "2026-10-01": {
      claude: {
        sessions: 2,
        slots: { "": { sessions: 2, models: { "claude-opus-5-5": bucket(1_000, 4), "claude-sonnet-5": bucket(200, 0) } } },
      },
      "opencode-go": {
        sessions: 1,
        slots: {
          "": { sessions: 1, models: { "deepseek-v4.1-flash": bucket(1_000, 2) } },
          "2": { sessions: 1, models: { "deepseek-v4.1-flash": bucket(2_000, 4) } },
        },
      },
    },
    "2026-10-02": {
      claude: { sessions: 0, slots: { "": { models: { "claude-opus-5-5": bucket(800, 2) } } } },
    },
  },
};

const SEPTEMBER = {
  schemaVersion: 1,
  month: "2026-09",
  days: {
    "2026-09-30": {
      claude: { sessions: 1, slots: { "": { models: { "claude-opus-5-5": bucket(700, 2) } } } },
    },
  },
};

function writeHistory(dir, { totals = TOTALS, months = { "2026-09": SEPTEMBER, "2026-10": OCTOBER } } = {}) {
  mkdirSync(dir, { recursive: true });
  if (totals !== null) writeFileSync(join(dir, "totals.json"), JSON.stringify(totals, null, 2));
  for (const [month, body] of Object.entries(months)) {
    writeFileSync(join(dir, `tokens-${month}.json`), JSON.stringify(body));
  }
}

/** Run the command and return the parsed JSON it printed. */
function statsJson(options = {}) {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    assert.equal(
      runStatsCommand({ json: true, historyDir: options.historyDir, month: options.month, now: options.now, cachePath: options.cachePath }),
      0,
    );
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(output);
}

/** The live month these fixtures were written for; never the day the suite runs. */
const NOW_OCTOBER = new Date(2026, 9, 15, 12, 0, 0);

/** Every file under the tree with its bytes, to prove a read changed nothing. */
function snapshot(dir) {
  const files = {};
  for (const name of readdirSync(dir).sort()) files[name] = readFileSync(join(dir, name), "utf-8");
  return files;
}

test("stats --json lists the months, one month's days and the all-time totals", () => {
  const tree = tempHistory();
  writeHistory(tree.dir);

  const payload = statsJson({ historyDir: tree.dir, now: NOW_OCTOBER });
  assert.equal(payload.schemaVersion, 1);
  assert.deepEqual(payload.months, ["2026-09", "2026-10"]);
  assert.equal(payload.month, "2026-10", "the live month is the default");
  assert.deepEqual(payload.quarantined, []);
  assert.deepEqual(payload.notes, []);

  assert.deepEqual(payload.days["2026-10-01"].claude, {
    sessions: 2,
    tokens: 1_200,
    prompts: 4,
    slots: {
      "": {
        sessions: 2,
        tokens: 1_200,
        prompts: 4,
        models: { "claude-opus-5-5": { tokens: 1_000, messages: 4 }, "claude-sonnet-5": { tokens: 200, messages: 0 } },
      },
    },
  });
  assert.deepEqual(Object.keys(payload.days["2026-10-01"]["opencode-go"].slots).sort(), ["", "2"], "the base slot stays unnumbered");
  assert.equal(payload.days["2026-10-01"]["opencode-go"].tokens, 3_000);

  assert.equal(payload.totals.lastFrozenDay, "2026-10-02");
  assert.deepEqual(Object.keys(payload.totals.families["opencode-go"].accounts), ["#1", "#2"], "the unlabelled totals key reads back as #1");
  assert.equal(payload.totals.families.claude.modelUsage["claude-opus-5-5"].input, 2_000, "totals keep the stored bucket shape");
});

test("stats --json reads the requested month and says when it has no file", () => {
  const tree = tempHistory();
  writeHistory(tree.dir);

  const september = statsJson({ historyDir: tree.dir, month: "2026-09", now: NOW_OCTOBER });
  assert.equal(september.month, "2026-09");
  assert.deepEqual(Object.keys(september.days), ["2026-09-30"]);
  assert.equal(september.days["2026-09-30"].claude.tokens, 700);

  const missing = statsJson({ historyDir: tree.dir, month: "2026-08", now: NOW_OCTOBER });
  assert.equal(missing.month, "2026-08");
  assert.deepEqual(missing.days, {});
  assert.ok(missing.notes.some((note) => /no frozen days for 2026-08/.test(note)), JSON.stringify(missing.notes));
});

test("the live month is listable and the default even with no month file", () => {
  const tree = tempHistory();
  writeHistory(tree.dir);

  // The 2nd of a month whose file does not exist yet: the durable month has no
  // frozen day, but the overlay merges today from the live report, so the month
  // must still be reachable — on a fresh install mid-month as much as on the 1st.
  const live = statsJson({ historyDir: tree.dir, now: new Date(2026, 10, 2, 9, 0, 0) });
  assert.deepEqual(live.months, ["2026-09", "2026-10", "2026-11"], "the live month is listed with the months that have a file");
  assert.equal(live.month, "2026-11", "History opens on the live month, not on the newest file");
  assert.deepEqual(live.days, {}, "the live month has no frozen day yet");
  assert.deepEqual(live.notes, [], "a month that is simply not frozen yet is not a warning");
  assert.equal(live.totals.lastFrozenDay, "2026-10-02", "the all-time rollup is unaffected");

  // Asking for it explicitly reads the same empty month, still without a note.
  const requested = statsJson({ historyDir: tree.dir, month: "2026-11", now: new Date(2026, 10, 2, 9, 0, 0) });
  assert.equal(requested.month, "2026-11");
  assert.deepEqual(requested.days, {});
  assert.deepEqual(requested.notes, []);
});

test("a corrupt or quarantined month is a note and is left byte-for-byte untouched", () => {
  const tree = tempHistory();
  writeHistory(tree.dir, { months: { "2026-10": OCTOBER } });
  const corrupt = join(tree.dir, "tokens-2026-11.json");
  writeFileSync(corrupt, '{"schemaVersion":1,"month":"2026-11","days":');
  const quarantined = join(tree.dir, "tokens-2026-08.json.corrupt-1");
  writeFileSync(quarantined, "{not json");
  const before = snapshot(tree.dir);

  const corruptRead = statsJson({ historyDir: tree.dir, month: "2026-11", now: NOW_OCTOBER });
  assert.equal(corruptRead.notes.length, 1, `one note per damaged month: ${JSON.stringify(corruptRead.notes)}`);
  assert.match(corruptRead.notes[0], /corrupt or from another version/);
  assert.match(corruptRead.notes[0], /unavailable/);
  assert.doesNotMatch(corruptRead.notes[0], /lock owner|delete that backup|Copy /, "a reader gets a line, not the writer's recovery instructions");
  assert.ok(corruptRead.notes[0].length < corrupt.length + 140, "the note stays one short line");
  assert.deepEqual(corruptRead.days, {});
  assert.deepEqual(snapshot(tree.dir), before, "a read-only command never quarantines or rewrites a month");

  const quarantinedRead = statsJson({ historyDir: tree.dir, month: "2026-08", now: NOW_OCTOBER });
  assert.equal(quarantinedRead.notes.length, 1, `one note per quarantined month: ${JSON.stringify(quarantinedRead.notes)}`);
  assert.match(quarantinedRead.notes[0], /quarantined as .*tokens-2026-08\.json\.corrupt-1/);
  assert.doesNotMatch(quarantinedRead.notes[0], /lock owner|delete that backup|Copy /);
  const quarantineBudget = join(tree.dir, "tokens-2026-08.json").length + quarantined.length + 140;
  assert.ok(quarantinedRead.notes[0].length < quarantineBudget, "the note stays one short line");
  assert.deepEqual(quarantinedRead.days, {});
  assert.deepEqual(quarantinedRead.quarantined, ["2026-08"]);
  assert.deepEqual(quarantinedRead.months, ["2026-10", "2026-11"], "a month file that exists is listable even when unreadable");
  assert.equal(quarantinedRead.months.includes("2026-08"), false, "a quarantined month has no browsable days");
  assert.deepEqual(snapshot(tree.dir), before);
});

test("a corrupt totals file is a note, not a rebuild or a quarantine", () => {
  const tree = tempHistory();
  writeHistory(tree.dir);
  writeFileSync(join(tree.dir, "totals.json"), "{ definitely not totals");
  const before = snapshot(tree.dir);

  const payload = statsJson({ historyDir: tree.dir, now: NOW_OCTOBER });
  assert.equal(payload.totals, null);
  assert.ok(payload.notes.some((note) => /not valid JSON/.test(note)), JSON.stringify(payload.notes));
  assert.deepEqual(snapshot(tree.dir), before);
});

test("stats --json takes no lock and writes nothing", () => {
  const tree = tempHistory();
  writeHistory(tree.dir);
  const before = snapshot(tree.dir);

  for (let run = 0; run < 3; run += 1) statsJson({ historyDir: tree.dir, cachePath: tree.cachePath, now: NOW_OCTOBER });

  assert.deepEqual(snapshot(tree.dir), before);
  assert.deepEqual(readdirSync(tree.cachePath ? join(tree.cachePath, "..") : tree.root), [], "no lock file is created in the cache directory");
});

test("a concurrent writer replacing month files atomically never breaks a read", async () => {
  const tree = tempHistory();
  writeHistory(tree.dir);
  const publishes = 400;
  // One model per body, so a whole-file read is also an internally consistent one.
  const body = (tokens) => ({
    schemaVersion: 1,
    month: "2026-10",
    days: {
      "2026-10-01": {
        claude: {
          sessions: 1,
          slots: { "": { sessions: 1, models: { "claude-opus-5-5": bucket(tokens, 1) } } },
        },
      },
    },
  });
  writeFileSync(join(tree.dir, "tokens-2026-10.json"), JSON.stringify(body(1_000)));
  // A real second process: publishing and reading in one process is sequential,
  // so it can never catch a torn read. The writer publishes 1000…1000+publishes-1
  // the way the scanner does — build a whole file, rename it over the old one.
  const script = join(tree.root, "writer.mjs");
  writeFileSync(
    script,
    `import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const count = Number(process.argv[3]);
const path = join(dir, "tokens-2026-10.json");
const tmp = join(dir, "tokens-2026-10.json.tmp");
const pause = new Int32Array(new SharedArrayBuffer(4));

try {
  for (let index = 0; index < count; index += 1) {
    const tokens = 1000 + index;
    const body = {
      schemaVersion: 1,
      month: "2026-10",
      days: {
        "2026-10-01": {
          claude: {
            sessions: 1,
            slots: { "": { sessions: 1, models: { "claude-opus-5-5": { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } } } },
          },
        },
      },
    };
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, path);
    Atomics.wait(pause, 0, 0, 1);
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}
`,
  );
  const child = spawn(process.execPath, [script, tree.dir, String(publishes)], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let running = true;
  const exited = new Promise((resolve) => {
    child.on("exit", (code) => {
      running = false;
      resolve(code);
    });
  });

  const seen = new Set();
  let reads = 0;
  let readsWhileRunning = 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const payload = historyJson({ historyDir: tree.dir, month: "2026-10" });
    reads += 1;
    if (running) readsWhileRunning += 1;
    assert.equal(payload.month, "2026-10");
    const day = payload.days["2026-10-01"].claude;
    const tokens = day.slots[""].models["claude-opus-5-5"].tokens;
    // Every read parses a whole file, and its rows agree with each other: a read
    // that caught a half-written file would throw, and one that caught a stale
    // file would show a value from outside the published sequence.
    assert.equal(day.tokens, tokens, "the family total and its slot/model rows come from the same file");
    assert.ok(tokens >= 1_000 && tokens < 1_000 + publishes, `read ${tokens} is one of the ${publishes} published values`);
    seen.add(tokens);
    // Yield so the child's exit can land: the loop must not outlive the writer.
    await new Promise((resolve) => setImmediate(resolve));
    if (!running) break;
  }

  assert.equal(await exited, 0, `the writer exited cleanly: ${stderr}`);
  assert.equal(stderr, "", "the writer never failed to publish");
  assert.ok(readsWhileRunning > 0, "at least one read ran while the writer process was still alive");
  assert.ok(reads > 50, `${reads} reads, not a handful`);
  assert.ok(seen.size > 1, `reads saw the writer move, not one stale file: ${Array.from(seen).slice(0, 5)}`);
  assert.ok(!existsSync(join(tree.dir, "tokens-2026-10.json.tmp")), "the last rename consumed the temp file");
  assert.deepEqual(readdirSync(tree.dir).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");
});
