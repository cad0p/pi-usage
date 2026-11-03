/**
 * `piquota stats`: read or rebuild the durable token history.
 *
 * The history is the one place tokens accumulate across runs; this command is
 * the read-only view of it and the recovery path for a lost `totals.json`.
 * `--json` never takes the history lock and never writes: it lists the months
 * that have a file, one month's normalized days and the all-time rollup, and
 * reports missing, quarantined or unreadable files as notes.
 */

import { readFileSync } from "node:fs";

import {
  acquireHistoryLock,
  bucketMessages,
  bucketTokens,
  listHistoryMonths,
  loadTotals,
  parseTotals,
  readMonthFile,
  rebuildTotalsFromMonths,
  releaseHistoryLock,
  resolveHistoryDir,
  resolveTotalsPath,
  totalsToJson,
} from "../../local/history.js";
import { resolveLocalStatsCachePath } from "../../local/pi-sessions.js";
import { redact } from "../../http.js";
import { err, out } from "../output.js";

/** The local month key of now, matching how the history files are named. */
function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * One month's day rows, normalized for consumers: per family and slot, the
 * token and prompt totals plus the per-model split. Only aggregate counts.
 *
 * @param {Record<string, Record<string, any>>} days
 * @returns {Record<string, Record<string, any>>}
 */
function daysToJson(days) {
  const result = {};
  for (const [date, families] of Object.entries(days ?? {})) {
    const day = {};
    for (const [family, familyRow] of Object.entries(families ?? {})) {
      const slots = {};
      let tokens = 0;
      let prompts = 0;
      for (const [slot, slotRow] of Object.entries(familyRow?.slots ?? {})) {
        const models = {};
        let slotTokens = 0;
        let slotPrompts = 0;
        for (const [model, bucket] of Object.entries(slotRow?.models ?? {})) {
          const modelTokens = bucketTokens(bucket);
          const messages = bucketMessages(bucket);
          models[model] = { tokens: modelTokens, messages };
          slotTokens += modelTokens;
          slotPrompts += messages;
        }
        slots[slot] = { sessions: Number(slotRow?.sessions) || 0, tokens: slotTokens, prompts: slotPrompts, models };
        tokens += slotTokens;
        prompts += slotPrompts;
      }
      day[family] = { sessions: Number(familyRow?.sessions) || 0, tokens, prompts, slots };
    }
    result[date] = day;
  }
  return result;
}

/**
 * Read totals.json without ever moving, rebuilding or writing it: a corrupt
 * file is reported as a note and left exactly where it is, because a read-only
 * command must not take a lock or race the writer.
 *
 * @param {string} historyDir
 * @param {string[]} notes
 * @returns {Record<string, unknown> | null}
 */
function readTotalsReadOnly(historyDir, notes) {
  const path = resolveTotalsPath(historyDir);
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code !== "ENOENT") {
      notes.push(`could not read ${path} (${redact(/** @type {{ message?: string }} */ (error)?.message)}); it is left untouched and all-time totals are unavailable`);
    } else {
      notes.push(`no all-time totals at ${path} yet`);
    }
    return null;
  }
  try {
    const totals = parseTotals(JSON.parse(raw));
    if (!totals) {
      notes.push(`${path} is unreadable or from another version; it is left untouched and all-time totals are unavailable`);
      return null;
    }
    return totalsToJson(totals);
  } catch {
    notes.push(`${path} is not valid JSON; it is left untouched and all-time totals are unavailable`);
    return null;
  }
}

/**
 * `stats --json`: the read-only history feed. Lists the browsable months, returns
 * the requested (default: the live local month) month's days, the all-time
 * rollup and the notes for anything missing or damaged.
 *
 * The live month is always in `months` and is the default, even when it has no
 * file yet: its open day is not frozen, and on the 1st of a month — or on a
 * fresh install with older files present — a files-only list would make the
 * current month unreachable from the /usage History page.
 *
 * @param {{ historyDir: string, month?: string | null, now?: Date }} input
 * @returns {Record<string, unknown>}
 */
export function historyJson(input) {
  const { historyDir } = input;
  const notes = [];
  const listed = listHistoryMonths(historyDir);
  const requested = typeof input.month === "string" && input.month !== "" ? input.month : null;
  const live = currentMonth(input.now instanceof Date ? input.now : new Date());
  const months = Array.from(new Set([...listed.months, live])).sort();
  const selected = requested ?? live;
  const quarantinedRequest = requested === null ? null : listed.quarantined.find((entry) => entry.month === requested);
  if (requested !== null && !months.includes(requested) && !quarantinedRequest) {
    notes.push(`no frozen days for ${requested} in ${historyDir}`);
  }
  // One note per damaged month: readMonthFile explains the quarantine or the
  // corruption once, in the reader's terms, instead of the writer's recovery
  // instructions on top of a second note from here.
  const month = readMonthFile(historyDir, selected, notes, { canWrite: false, concise: true });
  return {
    schemaVersion: 1,
    historyDir,
    generatedAt: new Date().toISOString(),
    months,
    quarantined: listed.quarantined.map((entry) => entry.month),
    month: selected,
    days: daysToJson(month.days),
    totals: readTotalsReadOnly(historyDir, notes),
    notes,
  };
}

/**
 * @param {{
 *   rebuild?: boolean,
 *   json?: boolean,
 *   month?: string | null,
 *   now?: Date,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   historyDir?: string,
 *   cachePath?: string,
 * }} [options]
 * @returns {number} Exit code.
 */
export function runStatsCommand(options = {}) {
  const env = options.env ?? process.env;
  const historyDir = options.historyDir ?? resolveHistoryDir({ env, home: options.home });
  /** @type {string[]} */
  const warnings = [];

  if (options.json) {
    // No lock, no writes: a concurrent scan may be freezing a day while this
    // reads, and every history file is replaced atomically, so a reader only
    // ever sees a whole file.
    out(JSON.stringify(historyJson({ historyDir, month: options.month, now: options.now }), null, 2));
    return 0;
  }

  if (options.rebuild) {
    // The rebuild rewrites the same file a scan freezes into, so it takes the
    // same lock: a concurrent scan must not interleave its freeze with it.
    const lockPath = `${options.cachePath ?? resolveLocalStatsCachePath({ env, home: options.home })}.lock`;
    const lock = acquireHistoryLock({ lockPath });
    if (!lock.acquired) {
      err(`stats: another piquota run holds the history lock (${lock.path}); try again in a moment`);
      return 1;
    }
    let result;
    try {
      result = rebuildTotalsFromMonths({ historyDir, warnings });
    } finally {
      releaseHistoryLock(lock);
    }
    for (const warning of warnings) err(`warning: ${warning}`);
    if (!result.ok) {
      err(`stats: could not rebuild the history totals: ${redact(result.error ?? "unknown error")}`);
      return 1;
    }
    out(
      `stats: rebuilt ${result.path} from ${result.months} month file(s): ${result.days} frozen day(s), ` +
        `${result.families} family/ies, last frozen day ${result.lastFrozenDay || "none"}`,
    );
    return 0;
  }

  const history = loadTotals({ historyDir, warnings });
  for (const warning of warnings) err(`warning: ${warning}`);
  if (!history.exists || history.totals.families.size === 0) {
    out(`stats: no frozen token history at ${historyDir}`);
    return 0;
  }

  let prompts = 0;
  let sessions = 0;
  const days = new Set();
  for (const family of history.totals.families.values()) {
    prompts += family.totalPrompts;
    sessions += family.totalSessions;
    for (const date of family.activeDates) days.add(date);
  }
  out(`stats: ${historyDir}`);
  out(`  last frozen day: ${history.totals.lastFrozenDay || "none"}`);
  out(`  families: ${Array.from(history.totals.families.keys()).sort().join(", ")}`);
  out(`  frozen days: ${days.size} · prompts: ${prompts} · session-days: ${sessions}`);
  return 0;
}
