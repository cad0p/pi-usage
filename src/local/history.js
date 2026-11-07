/**
 * Durable token history.
 *
 * The per-file scan cache under `~/.cache/pi-quota/` is disposable: it exists to
 * avoid re-reading session bytes. The history here is not: once a local day is
 * over it is frozen, and from then on it belongs to this ledger, not to the
 * session files. Deleting a session, clearing the cache or losing today's
 * numbers never rewrites a frozen day.
 *
 * Layout, under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage/` (Pi's own data
 * directory, so token history travels with the agent installation):
 *
 *   totals.json          constant-size all-time rollup: per family and account,
 *                        per-model buckets, prompt and session totals, active
 *                        dates, first day, and `lastFrozenDay` — the watermark
 *                        that makes a restart never add a day twice.
 *   tokens-YYYY-MM.json  one file per local month: day -> family -> slot ->
 *                        model. SET semantics per day, so re-freezing a day
 *                        after a crash is idempotent. A run reads only the
 *                        months covering the last seven days.
 *
 * Freezing order is month file first, then totals. A crash in between leaves
 * `lastFrozenDay` behind, so the next run re-freezes the day from the open-day
 * cache (which is only pruned after the totals write) and the SET write makes
 * that harmless. Late writes to an already-frozen day (a session that appends
 * past midnight) increment both the month file and the totals directly; a crash
 * between those two writes can double that small delta, which is the one
 * non-idempotent window in this design.
 *
 * A lost or corrupt totals file is moved aside as `totals.json.corrupt-<ts>`
 * and rebuilt from the month files, never from sessions. Corrupt or unreadable
 * month files block that rebuild so their counts cannot be silently discarded.
 * `piquota stats --rebuild-totals` also refuses an incomplete month set.
 */

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { redact } from "../http.js";

/** Version of the durable formats; a foreign version is treated as corruption. */
export const HISTORY_SCHEMA_VERSION = 1;

const MONTH_FILE = /^tokens-(\d{4}-\d{2})\.json$/;

/**
 * @typedef {Object} Bucket
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} messages
 */

/**
 * One account's row for a day: distinct session files plus per-model buckets.
 *
 * @typedef {Object} SlotRow
 * @property {number} sessions
 * @property {Record<string, Bucket>} models
 */

/**
 * One family's row for a day.
 *
 * @typedef {Object} FamilyRow
 * @property {number} sessions
 * @property {Record<string, SlotRow>} slots
 */

/** One day's rows, keyed by family. */
/** @typedef {Record<string, FamilyRow>} DayRows */

/**
 * @typedef {Object} FamilyTotals
 * @property {string} firstDay
 * @property {Set<string>} activeDates
 * @property {number} totalPrompts
 * @property {number} totalSessions
 * @property {Map<string, Bucket>} models
 * @property {Map<string, AccountTotals>} accounts
 */

/**
 * @typedef {Object} AccountTotals
 * @property {number} totalPrompts
 * @property {number} totalSessions
 * @property {Map<string, Bucket>} models
 */

/**
 * @typedef {Object} Totals
 * @property {string} lastFrozenDay
 * @property {Map<string, FamilyTotals>} families
 */

/**
 * Pi's agent directory: `PI_CODING_AGENT_DIR` wins, otherwise `~/.pi/agent`.
 * The session scanner resolves its roots through the same value.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveAgentDir(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return env.PI_CODING_AGENT_DIR ? resolve(env.PI_CODING_AGENT_DIR) : join(home, ".pi", "agent");
}

/**
 * Where the durable history lives. `historyDir` is the test seam: the suite
 * must never write into the real `~/.pi`.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, historyDir?: string }} [options]
 * @returns {string}
 */
export function resolveHistoryDir(options = {}) {
  return options.historyDir ?? join(resolveAgentDir(options), "pi-usage");
}

/**
 * @param {string} historyDir
 * @returns {string}
 */
export function resolveTotalsPath(historyDir) {
  return join(historyDir, "totals.json");
}

/**
 * @param {string} historyDir
 * @param {string} month YYYY-MM
 * @returns {string}
 */
export function resolveMonthPath(historyDir, month) {
  return join(historyDir, `tokens-${month}.json`);
}

/**
 * @param {string} historyDir
 * @param {string} month
 * @returns {string | null}
 */
function quarantinedMonthPath(historyDir, month) {
  try {
    const prefix = `tokens-${month}.json.corrupt-`;
    const name = readdirSync(historyDir).find((entry) => entry.startsWith(prefix));
    return name ? join(historyDir, name) : null;
  } catch {
    return null;
  }
}

/**
 * The months with a month file on disk, plus any quarantined copies, read-only:
 * `stats --json` and the overlay use this to know what can be browsed without
 * taking the history lock or touching a file.
 *
 * @param {string} historyDir
 * @returns {{ months: string[], quarantined: Array<{ month: string, path: string }> }}
 */
export function listHistoryMonths(historyDir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(historyDir);
  } catch {
    return { months: [], quarantined: [] };
  }
  const months = new Set();
  const quarantined = new Map();
  for (const name of names) {
    const month = MONTH_FILE.exec(name)?.[1];
    if (month) {
      months.add(month);
      continue;
    }
    const backup = /^tokens-(\d{4}-\d{2})\.json\.corrupt-/.exec(name);
    if (backup && !quarantined.has(backup[1])) quarantined.set(backup[1], join(historyDir, name));
  }
  return {
    months: Array.from(months).sort(),
    quarantined: Array.from(quarantined, ([month, path]) => ({ month, path })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/**
 * Whether the history directory holds any frozen month file at all.
 *
 * @param {string} historyDir
 * @returns {boolean}
 */
export function hasMonthFiles(historyDir) {
  try {
    return readdirSync(historyDir).some((name) => MONTH_FILE.test(name) || /^tokens-\d{4}-\d{2}\.json\.corrupt-/.test(name));
  } catch {
    return false;
  }
}

/**
 * @param {string} slot
 * @returns {string} "#1" for the base entry (the first account of the family),
 * "#<slot>" for a sibling slot ("#2", "#1-api").
 */
export function accountLabel(slot) {
  return slot === "" || slot === null || slot === undefined ? "#1" : `#${slot}`;
}

/**
 * @param {string} slot
 * @returns {number}
 */
export function accountOrder(slot) {
  if (slot === "") return -1;
  const numeric = Number.parseInt(slot, 10);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

/**
 * @returns {Bucket}
 */
export function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
}

/**
 * @param {Bucket} bucket
 * @returns {number}
 */
export function bucketTokens(bucket) {
  return (bucket?.input ?? 0) + (bucket?.output ?? 0) + (bucket?.cacheRead ?? 0) + (bucket?.cacheWrite ?? 0);
}

/**
 * @param {Bucket} bucket
 * @returns {number}
 */
export function bucketMessages(bucket) {
  return bucket?.messages ?? 0;
}

/**
 * @param {Bucket} target
 * @param {Bucket} source
 */
export function addIntoBucket(target, source) {
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.messages += source.messages ?? 0;
}

/**
 * @param {Map<string, Bucket>} models
 * @param {string} model
 * @param {Bucket} bucket
 */
export function addToModels(models, model, bucket) {
  const target = models.get(model) ?? emptyBucket();
  addIntoBucket(target, bucket);
  models.set(model, target);
}

/**
 * Sum a family row's tokens.
 *
 * @param {FamilyRow} familyRow
 * @returns {number}
 */
export function familyRowTokens(familyRow) {
  let total = 0;
  for (const slotRow of Object.values(familyRow?.slots ?? {})) {
    for (const bucket of Object.values(slotRow?.models ?? {})) total += bucketTokens(bucket);
  }
  return total;
}

/**
 * Sum a family row's assistant messages.
 *
 * @param {FamilyRow} familyRow
 * @returns {number}
 */
export function familyRowMessages(familyRow) {
  let total = 0;
  for (const slotRow of Object.values(familyRow?.slots ?? {})) {
    for (const bucket of Object.values(slotRow?.models ?? {})) total += bucketMessages(bucket);
  }
  return total;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function maxDay(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * @param {DayRows} rows
 * @returns {DayRows}
 */
export function cloneDayRows(rows) {
  return JSON.parse(JSON.stringify(rows));
}

/**
 * @returns {Totals}
 */
export function emptyTotals() {
  return { lastFrozenDay: "", families: new Map() };
}

/**
 * @param {Totals} totals
 * @param {string} family
 * @returns {FamilyTotals}
 */
function ensureFamily(totals, family) {
  let entry = totals.families.get(family);
  if (!entry) {
    entry = { firstDay: "", activeDates: new Set(), totalPrompts: 0, totalSessions: 0, models: new Map(), accounts: new Map() };
    totals.families.set(family, entry);
  }
  return entry;
}

/**
 * @param {FamilyTotals} family
 * @param {string} slot
 * @returns {AccountTotals}
 */
function ensureAccount(family, slot) {
  const label = accountLabel(slot);
  let account = family.accounts.get(label);
  if (!account) {
    account = { totalPrompts: 0, totalSessions: 0, models: new Map() };
    family.accounts.set(label, account);
  }
  return account;
}

/**
 * Fold one complete, frozen day into the all-time rollup.
 *
 * @param {Totals} totals
 * @param {string} day
 * @param {DayRows} dayRows
 */
export function applyDayToTotals(totals, day, dayRows) {
  for (const [family, familyRow] of Object.entries(dayRows ?? {})) {
    if (!familyRow || typeof familyRow !== "object") continue;
    const familyTotals = ensureFamily(totals, family);
    familyTotals.activeDates.add(day);
    if (!familyTotals.firstDay || day < familyTotals.firstDay) familyTotals.firstDay = day;
    familyTotals.totalSessions += Number(familyRow.sessions) || 0;

    for (const [slot, slotRow] of Object.entries(familyRow.slots ?? {})) {
      if (!slotRow || typeof slotRow !== "object") continue;
      const account = ensureAccount(familyTotals, slot);
      account.totalSessions += Number(slotRow.sessions) || 0;
      for (const [model, bucket] of Object.entries(slotRow.models ?? {})) {
        if (!bucket || typeof bucket !== "object") continue;
        addToModels(familyTotals.models, model, bucket);
        addToModels(account.models, model, bucket);
        const messages = bucketMessages(bucket);
        familyTotals.totalPrompts += messages;
        account.totalPrompts += messages;
      }
    }
  }
}

/**
 * Fold a late write into a day that is already frozen. Session counts are left
 * alone: the day froze with its session list, and a late append comes from a
 * session that day already counted (or from a month file that no longer knows
 * it, in which case counting it again would be worse than omitting it).
 *
 * @param {Totals} totals
 * @param {string} day
 * @param {DayRows} dayRows
 */
export function applyLateToTotals(totals, day, dayRows) {
  for (const [family, familyRow] of Object.entries(dayRows ?? {})) {
    if (!familyRow || typeof familyRow !== "object") continue;
    const familyTotals = ensureFamily(totals, family);
    familyTotals.activeDates.add(day);
    if (!familyTotals.firstDay || day < familyTotals.firstDay) familyTotals.firstDay = day;
    for (const [slot, slotRow] of Object.entries(familyRow.slots ?? {})) {
      if (!slotRow || typeof slotRow !== "object") continue;
      const account = ensureAccount(familyTotals, slot);
      for (const [model, bucket] of Object.entries(slotRow.models ?? {})) {
        if (!bucket || typeof bucket !== "object") continue;
        addToModels(familyTotals.models, model, bucket);
        addToModels(account.models, model, bucket);
        const messages = bucketMessages(bucket);
        familyTotals.totalPrompts += messages;
        account.totalPrompts += messages;
      }
    }
  }
}

/**
 * @param {Map<string, Bucket>} models
 * @returns {Record<string, Bucket>}
 */
function modelsToJson(models) {
  /** @type {Record<string, Bucket>} */
  const out = {};
  for (const [model, bucket] of models) out[model] = { ...bucket };
  return out;
}

/**
 * Serialize the internal rollup into the versioned `totals.json` shape.
 *
 * @param {Totals} totals
 * @returns {Record<string, unknown>}
 */
export function totalsToJson(totals) {
  /** @type {Record<string, unknown>} */
  const families = {};
  for (const [family, entry] of totals.families) {
    /** @type {Record<string, unknown>} */
    const accounts = {};
    for (const [label, account] of entry.accounts) {
      accounts[label] = {
        totalPrompts: account.totalPrompts,
        totalSessions: account.totalSessions,
        modelUsage: modelsToJson(account.models),
      };
    }
    families[family] = {
      firstDay: entry.firstDay,
      activeDates: Array.from(entry.activeDates).sort(),
      totalPrompts: entry.totalPrompts,
      totalSessions: entry.totalSessions,
      modelUsage: modelsToJson(entry.models),
      accounts,
    };
  }
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    lastFrozenDay: totals.lastFrozenDay,
    families,
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

/**
 * @param {unknown} raw
 * @returns {Map<string, Bucket>}
 */
function modelsFromJson(raw) {
  /** @type {Map<string, Bucket>} */
  const models = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return models;
  for (const [model, bucket] of Object.entries(raw)) {
    if (!bucket || typeof bucket !== "object") continue;
    models.set(model, {
      input: count(/** @type {Record<string, unknown>} */ (bucket).input),
      output: count(/** @type {Record<string, unknown>} */ (bucket).output),
      cacheRead: count(/** @type {Record<string, unknown>} */ (bucket).cacheRead),
      cacheWrite: count(/** @type {Record<string, unknown>} */ (bucket).cacheWrite),
      messages: count(/** @type {Record<string, unknown>} */ (bucket).messages),
    });
  }
  return models;
}

/**
 * Parse a totals file, or return null when it is not one this version wrote.
 *
 * @param {unknown} raw
 * @returns {Totals | null}
 */
export function parseTotals(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const object = /** @type {Record<string, unknown>} */ (raw);
  if (object.schemaVersion !== HISTORY_SCHEMA_VERSION) return null;
  if (typeof object.lastFrozenDay !== "string") return null;
  if (!object.families || typeof object.families !== "object" || Array.isArray(object.families)) return null;

  const totals = emptyTotals();
  totals.lastFrozenDay = object.lastFrozenDay;
  for (const [family, value] of Object.entries(object.families)) {
    if (!value || typeof value !== "object") continue;
    const entry = /** @type {Record<string, unknown>} */ (value);
    const familyTotals = ensureFamily(totals, family);
    familyTotals.firstDay = text(entry.firstDay);
    familyTotals.totalPrompts = count(entry.totalPrompts);
    familyTotals.totalSessions = count(entry.totalSessions);
    familyTotals.models = modelsFromJson(entry.modelUsage);
    if (Array.isArray(entry.activeDates)) {
      for (const day of entry.activeDates) if (typeof day === "string" && day !== "") familyTotals.activeDates.add(day);
    }
    if (entry.accounts && typeof entry.accounts === "object" && !Array.isArray(entry.accounts)) {
      for (const [rawLabel, accountValue] of Object.entries(entry.accounts)) {
        if (!accountValue || typeof accountValue !== "object") continue;
        // Files written while the base entry was unlabelled carry "" for it;
        // normalize on read so one account never shows up twice.
        const label = rawLabel === "" ? "#1" : rawLabel;
        const account = /** @type {Record<string, unknown>} */ (accountValue);
        familyTotals.accounts.set(label, {
          totalPrompts: count(account.totalPrompts),
          totalSessions: count(account.totalSessions),
          models: modelsFromJson(account.modelUsage),
        });
      }
    }
  }
  return totals;
}

/**
 * Move an unreadable history file aside instead of silently overwriting it.
 *
 * @param {string} path
 * @param {string[]} warnings
 * @param {string} label
 * @returns {boolean} Whether the path is free to be written again.
 */
export function quarantine(path, warnings, label) {
  const target = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, target);
    warnings.push(`${label} at ${path} was unreadable; moved it to ${target}`);
    return true;
  } catch (error) {
    warnings.push(
      `${label} at ${path} is unreadable and could not be moved aside (${redact(/** @type {{ message?: string }} */ (error)?.message)}); leaving it untouched`,
    );
    return false;
  }
}

/** How long a lock file may sit there before another run treats it as abandoned. */
export const DEFAULT_LOCK_STALE_MS = 120_000;

/**
 * Take an exclusive lock for one history write.
 *
 * Two writers are routine on this machine — the systemd timer that publishes
 * Omarchy records and the /usage panel asking for a report — and both would
 * otherwise load the same totals, apply the same late-write delta and write it
 * twice. The lock is an `O_EXCL` file next to the disposable cache (never inside
 * `~/.pi`, which is a git repository), holding the pid for debugging. A lock
 * whose mtime is older than `staleMs` was left by a killed run and is taken
 * over; a negative age (the clock moved backwards) is never treated as stale.
 *
 * @param {{
 *   lockPath: string,
 *   now?: number,
 *   staleMs?: number,
 * }} input
 * @returns {{ acquired: boolean, path: string, stale: boolean, reason?: string }}
 */
export function acquireHistoryLock(input) {
  const now = input.now ?? Date.now();
  const staleMs = Number.isFinite(input.staleMs) ? /** @type {number} */ (input.staleMs) : DEFAULT_LOCK_STALE_MS;
  const lockPath = input.lockPath;
  // The pid alone is not an owner: it is repeated across containers and after a
  // wrap, and the whole point of the token is that a run can prove the lock in
  // the file is still the one it created.
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    } catch (error) {
      return {
        acquired: false,
        path: lockPath,
        token: null,
        stale: false,
        reason: `cannot create the lock directory: ${redact(/** @type {{ message?: string }} */ (error)?.message)}`,
      };
    }
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${token}\n`, "utf-8");
      } finally {
        closeSync(fd);
      }
      return { acquired: true, path: lockPath, token, stale: false };
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code !== "EEXIST") {
        return {
          acquired: false,
          path: lockPath,
          token: null,
          stale: false,
          reason: redact(/** @type {{ message?: string }} */ (error)?.message ?? String(error)),
        };
      }
      let age = 0;
      try {
        age = now - statSync(lockPath).mtimeMs;
      } catch {
        // It vanished between open and stat: try once more.
        continue;
      }
      if (age > staleMs) {
        rmSync(lockPath, { force: true });
        continue;
      }
      return { acquired: false, path: lockPath, token: null, stale: false };
    }
  }
  return { acquired: false, path: lockPath, token: null, stale: true };
}

/**
 * @param {string} lockPath
 * @returns {string | null} The owner token currently in the file.
 */
function readLockToken(lockPath) {
  try {
    return readFileSync(lockPath, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Say "I am still here" so a long scan is never mistaken for a dead one.
 *
 * @param {{ path: string, token: string | null }} lock
 * @returns {boolean} Whether the lock is still ours.
 */
export function refreshHistoryLock(lock) {
  if (!lock?.token || readLockToken(lock.path) !== lock.token) return false;
  try {
    const now = new Date();
    utimesSync(lock.path, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release only a lock this run still owns: a run that was taken over must not
 * delete its successor's file. The lock object is required — a bare path cannot
 * prove ownership, and an unconditional unlink is exactly the bug this
 * signature prevents.
 *
 * @param {{ path: string, token: string | null } | null | undefined} lock
 * @returns {boolean} Whether the file was ours and is now gone.
 */
export function releaseHistoryLock(lock) {
  const path = lock?.path;
  const token = lock?.token;
  if (!path || !token) return false;
  if (readLockToken(path) !== token) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    // A lock that cannot be removed is reclaimed by the stale timeout.
    return false;
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o600 });
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    rmSync(temporary, { force: true });
    return { ok: false, error: redact(/** @type {{ message?: string }} */ (error)?.message ?? String(error)) };
  }
}

/**
 * Rebuild the rollup from the month files, in memory.
 *
 * The month files are the authoritative record of frozen days: `totals.json` is
 * a cache of them. Whenever it is missing or unreadable, this recreates it, so a
 * lost rollup can never make the scan treat a frozen day as open and overwrite
 * it with whatever sessions survive (review finding N3).
 *
 * @param {{ historyDir: string, warnings: string[] }} input
 * @returns {{ totals: Totals, months: number, days: number, unreadable: string[], quarantined: string[] }}
 */
export function totalsFromMonths(input) {
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(input.historyDir);
  } catch {
    return { totals: emptyTotals(), months: 0, days: 0, unreadable: [], quarantined: [] };
  }
  const months = names
    .map((name) => MONTH_FILE.exec(name))
    .filter((match) => match !== null)
    .map((match) => /** @type {RegExpExecArray} */ (match)[1])
    .sort();

  const totals = emptyTotals();
  /** @type {string[]} */
  const unreadable = [];
  const presentMonths = new Set(months);
  const quarantined = names
    .map((name) => /^tokens-(\d{4}-\d{2})\.json\.corrupt-/.exec(name)?.[1])
    .filter((month) => month !== undefined && !presentMonths.has(month));
  let days = 0;
  for (const month of months) {
    const entry = readMonthFile(input.historyDir, month, input.warnings, { canWrite: input.canWrite });
    if (entry.unreadable) unreadable.push(month);
    if (entry.quarantined && !quarantined.includes(month)) quarantined.push(month);
    if (!entry.writable) continue;
    for (const day of Object.keys(entry.days).sort()) {
      const rows = entry.days[day];
      if (!rows || typeof rows !== "object") continue;
      applyDayToTotals(totals, day, rows);
      totals.lastFrozenDay = maxDay(totals.lastFrozenDay, day);
      days += 1;
    }
  }
  return { totals, months: months.length, days, unreadable, quarantined };
}

/**
 * Load the durable rollup.
 *
 * A missing or corrupt totals file is rebuilt from complete month files, never
 * from session files. If any month is unreadable or quarantined, the rollup is
 * left untouched and this run cannot write history.
 *
 * @param {{ historyDir: string, warnings: string[], canWrite?: boolean }} input
 * @returns {{ totals: Totals, rescanAll: boolean, writable: boolean, path: string, exists: boolean, rebuiltFromMonths: boolean }}
 */
export function loadTotals(input) {
  const path = resolveTotalsPath(input.historyDir);
  /**
   * Restore the rollup from the complete month files. Session bytes are never
   * used to recreate a frozen day.
   *
   * @param {boolean} writableRollup Whether the rollup may be written now.
   */
  const fromMonths = (writableRollup) => {
    const rebuilt = totalsFromMonths({
      historyDir: input.historyDir,
      warnings: input.warnings,
      canWrite: writableRollup && input.canWrite !== false,
    });
    if (rebuilt.unreadable.length > 0 || rebuilt.quarantined.length > 0) {
      if (rebuilt.unreadable.length > 0) {
        input.warnings.push(
          `local token stats: month file(s) could not be read (${rebuilt.unreadable.join(", ")}); ` +
            "the rollup was not rewritten and no days were frozen into unreadable months",
        );
      }
      input.warnings.push(
        "local token stats: the rollup was not rewritten from an incomplete month set; restore the missing or quarantined history before rebuilding it",
      );
      return { totals: rebuilt.totals, rescanAll: true, writable: false, path, exists: false, rebuiltFromMonths: false };
    }
    if (rebuilt.months === 0) {
      return { totals: emptyTotals(), rescanAll: true, writable: writableRollup, path, exists: false, rebuiltFromMonths: false };
    }
    input.warnings.push(
      `local token stats: the history rollup was rebuilt from ${rebuilt.months} month file(s) (${rebuilt.days} frozen day(s))`,
    );
    if (writableRollup && input.canWrite !== false) {
      const written = writeJsonAtomic(path, totalsToJson(rebuilt.totals));
      if (!written.ok) {
        input.warnings.push(`local token stats: could not write the rebuilt history totals: ${written.error}`);
      }
    }
    return { totals: rebuilt.totals, rescanAll: true, writable: writableRollup, path, exists: true, rebuiltFromMonths: true };
  };

  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === "ENOENT") {
      return fromMonths(true);
    }
    input.warnings.push(`local token stats: could not read the history at ${path}: ${redact(/** @type {{ message?: string }} */ (error)?.message)}`);
    return fromMonths(false);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const totals = parseTotals(parsed);
  if (!totals) {
    const writable = quarantine(path, input.warnings, "local token history");
    if (!writable) return { totals: emptyTotals(), rescanAll: true, writable: false, path, exists: true, rebuiltFromMonths: false };
    return fromMonths(true);
  }
  // An empty rollup is either a fresh install (nothing has closed yet) or a
  // rollup that lost its numbers. Month files on disk settle it: they are the
  // evidence that something was frozen, so history is rebuilt from them.
  if (totals.families.size === 0 && totals.lastFrozenDay === "" && hasMonthFiles(input.historyDir)) {
    return fromMonths(true);
  }
  return { totals, rescanAll: false, writable: true, path, exists: true, rebuiltFromMonths: false };
}

/**
 * Read one month file. A corrupt month is moved aside by the lock owner; its
 * daily detail stays missing until the quarantined copy is restored. The
 * all-time totals it already fed are untouched.
 *
 * `concise` is for a read-only reader (`stats --json`): it gets one short note
 * per damaged month, not the writer's recovery instructions.
 *
 * @param {string} historyDir
 * @param {string} month
 * @param {string[]} warnings
 * @param {{ canWrite?: boolean, concise?: boolean }} [options]
 * @returns {{ days: Record<string, DayRows>, writable: boolean, exists: boolean, path: string }}
 */
export function readMonthFile(historyDir, month, warnings, options = {}) {
  const canWrite = options.canWrite !== false;
  const concise = options.concise === true;
  const path = resolveMonthPath(historyDir, month);
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === "ENOENT") {
      const backup = quarantinedMonthPath(historyDir, month);
      if (backup) {
        warnings.push(
          concise
            ? `local token stats: ${path} is quarantined as ${backup}; its frozen days are unavailable while totals.json keeps the all-time counts`
            : `local token stats: ${path} was quarantined as ${backup}; its frozen days are missing from recentDays (shown as 0), ` +
                `while totals.json keeps the all-time counts. Copy ${backup} back to ${path} if recoverable, or delete that backup to abandon those counts; days after it stay open until then`,
        );
      }
      return { days: {}, writable: true, exists: false, unreadable: false, quarantined: backup !== null, path };
    }
    // A permission or I/O error is temporary: the file is still there and may be
    // readable in a moment. It must NOT be quarantined, and the days it holds
    // must not be silently dropped from the rollup (review finding N9).
    warnings.push(
      `local token stats: could not read ${path} (${redact(/** @type {{ message?: string }} */ (error)?.message)}); ` +
        "leaving it untouched; its days stay pending and no reduced totals.json will be written",
    );
    return { days: {}, writable: false, exists: true, unreadable: true, quarantined: false, path };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const shapeOk = parsed && typeof parsed === "object" && parsed.schemaVersion === HISTORY_SCHEMA_VERSION && parsed.month === month
    && parsed.days && typeof parsed.days === "object" && !Array.isArray(parsed.days);
  if (!shapeOk) {
    if (!canWrite) {
      warnings.push(
        concise
          ? `local token stats: ${path} is corrupt or from another version; it is left untouched and its frozen days are unavailable`
          : `local token stats: ${path} is corrupt or from another version; leaving it in place because this run does not hold the history lock. ` +
              "Its days are missing from recentDays (shown as 0), while totals.json keeps the all-time counts; a lock owner can quarantine it for restoration",
      );
      return { days: {}, writable: false, exists: true, unreadable: true, quarantined: false, path };
    }
    const label = `local token history month ${month}`;
    const writable = quarantine(path, warnings, label);
    if (writable) {
      const backup = quarantinedMonthPath(historyDir, month);
      warnings.push(
        `local token stats: ${path} is corrupt or from another version; its frozen days are missing from recentDays (shown as 0), ` +
          `while totals.json keeps the all-time counts. Copy ${backup ?? `${path}.corrupt-<timestamp>`} back to ${path} if recoverable, or delete that backup to abandon those counts; days after it stay open until then`,
      );
    }
    return { days: {}, writable, exists: true, unreadable: !writable, quarantined: writable, path };
  }
  return { days: parsed.days, writable: true, exists: true, unreadable: false, quarantined: false, path };
}

/**
 * Increment an already-frozen day with late-written lines. SET semantics are
 * deliberately not used here: the day already exists and the new lines are a
 * delta, not a replacement.
 *
 * @param {Record<string, DayRows>} days
 * @param {string} day
 * @param {DayRows} deltaRows
 */
function incrementDayRows(days, day, deltaRows) {
  const target = days[day] ?? (days[day] = {});
  for (const [family, familyRow] of Object.entries(deltaRows)) {
    const familyTarget = target[family] ?? (target[family] = { sessions: 0, slots: {} });
    for (const [slot, slotRow] of Object.entries(familyRow.slots ?? {})) {
      const slotTarget = familyTarget.slots[slot] ?? (familyTarget.slots[slot] = { sessions: 0, models: {} });
      for (const [model, bucket] of Object.entries(slotRow.models ?? {})) {
        const bucketTarget = slotTarget.models[model] ?? (slotTarget.models[model] = emptyBucket());
        addIntoBucket(bucketTarget, bucket);
      }
    }
  }
}

/**
 * Write the durable part of a run: late increments to frozen days, then the
 * freeze of every closed day that is not frozen yet.
 *
 * Ordering is the crash-safety contract:
 *   1. month files (late increments and SET-frozen days),
 *   2. totals (increments + the new `lastFrozenDay`),
 *   3. the caller prunes those days from the disposable cache.
 * A crash before (2) leaves the watermark untouched, so the next run re-freezes
 * the day from the still-open cache and the SET write is idempotent. A day at
 * or below the watermark that is still open was already counted: it is dropped
 * without touching history, which is what makes a crash after (2) safe.
 *
 * @param {{
 *   historyDir: string,
 *   totals: Totals,
 *   openRows: Record<string, DayRows>,
 *   lateRows: Record<string, DayRows>,
 *   today: string,
 *   partial: boolean,
 *   writable: boolean,
 *   ensure?: boolean,
 *   warnings: string[],
 * }} input
 * @returns {{ droppedDays: Set<string>, frozenDays: string[], pendingLateDays: Set<string>, wroteTotals: boolean }}
 */
export function applyDurable(input) {
  /** @type {Set<string>} */
  const dropped = new Set();
  /** @type {string[]} */
  const candidates = [];
  for (const day of Object.keys(input.openRows)) {
    if (day >= input.today) continue;
    if (input.totals.lastFrozenDay && day <= input.totals.lastFrozenDay) dropped.add(day);
    else candidates.push(day);
  }
  candidates.sort();
  // A budget-truncated scan has not seen every session, so freezing now would
  // bake an incomplete day into history forever. Late increments are real
  // deltas from bytes that were read once, so they still apply.
  const freezeCandidates = input.partial ? [] : candidates;
  const lateDays = Object.keys(input.lateRows).sort();
  /** @type {Set<string>} */
  const pendingLateDays = new Set();
  if (freezeCandidates.length === 0 && lateDays.length === 0) {
    if (input.ensure && input.writable) {
      const written = writeJsonAtomic(resolveTotalsPath(input.historyDir), totalsToJson(input.totals));
      if (!written.ok) {
        input.warnings.push(`local token stats: could not write the history totals: ${written.error}`);
        return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: false };
      }
      return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: true };
    }
    return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: false };
  }
  if (!input.writable) {
    input.warnings.push("local token stats: the durable history is unreadable; this run leaves it untouched");
    for (const day of lateDays) pendingLateDays.add(day);
    return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: false };
  }

  /** @type {Map<string, { days: Record<string, DayRows>, writable: boolean }>} */
  const months = new Map();
  const monthFor = (day) => {
    const month = day.slice(0, 7);
    let entry = months.get(month);
    if (!entry) {
      entry = readMonthFile(input.historyDir, month, input.warnings, { canWrite: true });
      months.set(month, entry);
    }
    return entry;
  };

  /** @type {Set<string>} */
  const dirtyMonths = new Set();
  for (const day of lateDays) {
    const month = monthFor(day);
    if (!month.writable || month.quarantined) {
      pendingLateDays.add(day);
      continue;
    }
    incrementDayRows(month.days, day, input.lateRows[day]);
    dirtyMonths.add(day.slice(0, 7));
  }

  /** @type {string[]} */
  const blockedFreezeDays = [];
  for (const day of freezeCandidates) {
    const month = monthFor(day);
    if (!month.writable || month.quarantined) blockedFreezeDays.push(day);
  }
  // The watermark is a high-water mark. Do not freeze past the first day
  // blocked by an unreadable month, or a later freeze would make that open day
  // look already counted on the next run.
  const freezeCutoff = blockedFreezeDays[0] ?? null;
  const freezeDays = freezeCandidates.filter((day) => {
    const month = monthFor(day);
    return (!freezeCutoff || day < freezeCutoff) && month.writable && !month.quarantined;
  });
  for (const day of freezeDays) {
    const month = monthFor(day);
    month.days[day] = cloneDayRows(input.openRows[day]);
    dirtyMonths.add(day.slice(0, 7));
  }

  if (dirtyMonths.size === 0) {
    if (input.ensure && input.writable) {
      const written = writeJsonAtomic(resolveTotalsPath(input.historyDir), totalsToJson(input.totals));
      if (!written.ok) {
        input.warnings.push(`local token stats: could not write the history totals: ${written.error}`);
        return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: false };
      }
      return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: true };
    }
    return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: false };
  }

  // Month files first: a frozen day must be on disk before the watermark that
  // claims it is frozen can move. Unreadable months are skipped independently.
  const writtenMonths = new Set();
  for (const month of dirtyMonths) {
    const entry = months.get(month);
    const written = writeJsonAtomic(resolveMonthPath(input.historyDir, month), {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      month,
      days: entry.days,
    });
    if (!written.ok) {
      input.warnings.push(`local token stats: could not write the ${month} history: ${written.error}`);
      for (const day of lateDays) if (!writtenMonths.has(day.slice(0, 7))) pendingLateDays.add(day);
      return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: false };
    }
    writtenMonths.add(month);
  }

  const appliedLateDays = lateDays.filter((day) => !pendingLateDays.has(day));
  for (const day of appliedLateDays) applyLateToTotals(input.totals, day, input.lateRows[day]);
  for (const day of freezeDays) applyDayToTotals(input.totals, day, input.openRows[day]);
  if (freezeDays.length > 0) input.totals.lastFrozenDay = maxDay(input.totals.lastFrozenDay, freezeDays[freezeDays.length - 1]);

  const written = writeJsonAtomic(resolveTotalsPath(input.historyDir), totalsToJson(input.totals));
  if (!written.ok) {
    input.warnings.push(
      `local token stats: could not write the history totals: ${written.error}; the month files are ahead, so \`piquota stats --rebuild-totals\` can recover them`,
    );
    return { droppedDays: dropped, frozenDays: [], pendingLateDays, wroteTotals: false };
  }

  for (const day of freezeDays) dropped.add(day);
  return { droppedDays: dropped, frozenDays: freezeDays, pendingLateDays, wroteTotals: true };
}

/**
 * Read the month files that cover the seven-day window (current month and, early
 * in a month, the previous one). Nothing older is ever loaded for a report.
 *
 * @param {{ historyDir: string, dates: string[], warnings: string[], canWrite?: boolean }} input
 * @returns {Record<string, DayRows>}
 */
export function loadWindowDays(input) {
  const wanted = new Set(input.dates);
  const months = new Set(input.dates.map((date) => date.slice(0, 7)));
  /** @type {Record<string, DayRows>} */
  const days = {};
  for (const month of months) {
    const entry = readMonthFile(input.historyDir, month, input.warnings, { canWrite: input.canWrite });
    for (const [day, rows] of Object.entries(entry.days)) {
      if (wanted.has(day)) days[day] = rows;
    }
  }
  return days;
}

/**
 * Recompute totals.json from every month file. This is the recovery path when
 * totals is lost but the month files are not, and the way to verify the
 * incremental rollup.
 *
 * @param {{ historyDir: string, warnings: string[] }} input
 * @returns {{ ok: boolean, error?: string, months: number, days: number, families: number, lastFrozenDay: string, path: string }}
 */
export function rebuildTotalsFromMonths(input) {
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(input.historyDir);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code !== "ENOENT") {
      return { ok: false, error: redact(/** @type {{ message?: string }} */ (error)?.message ?? String(error)), months: 0, days: 0, families: 0, lastFrozenDay: "", path: resolveTotalsPath(input.historyDir) };
    }
  }

  const months = names
    .map((name) => MONTH_FILE.exec(name))
    .filter((match) => match !== null)
    .map((match) => /** @type {RegExpExecArray} */ (match)[1])
    .sort();
  const presentMonths = new Set(months);
  const quarantined = names.filter((name) => {
    const month = /^tokens-(\d{4}-\d{2})\.json\.corrupt-/.exec(name)?.[1];
    return month !== undefined && !presentMonths.has(month);
  });
  if (quarantined.length > 0) {
    return {
      ok: false,
      error: `quarantined month history remains under ${input.historyDir} (${quarantined.join(", ")}); restore it before rebuilding totals`,
      months: months.length,
      days: 0,
      families: 0,
      lastFrozenDay: "",
      path: resolveTotalsPath(input.historyDir),
    };
  }

  // Refuse to zero a rollup that still has numbers when the month files it
  // should be rebuilt from are gone: that turns one missing directory into
  // permanently lost history. The caller reports it and exits non-zero.
  if (months.length === 0) {
    const existing = loadTotals({ historyDir: input.historyDir, warnings: [] });
    if (existing.totals.families.size > 0) {
      return {
        ok: false,
        error:
          `no tokens-YYYY-MM.json under ${input.historyDir} while ${resolveTotalsPath(input.historyDir)} still has data; ` +
          "refusing to replace it with an empty rollup",
        months: 0,
        days: 0,
        families: 0,
        lastFrozenDay: existing.totals.lastFrozenDay,
        path: resolveTotalsPath(input.historyDir),
      };
    }
  }

  const totals = emptyTotals();
  let days = 0;
  for (const month of months) {
    const entry = readMonthFile(input.historyDir, month, input.warnings, { canWrite: true });
    if (entry.unreadable || entry.quarantined) {
      return {
        ok: false,
        error: entry.unreadable
          ? `${resolveMonthPath(input.historyDir, month)} could not be read; refusing to rebuild the rollup without it`
          : `${resolveMonthPath(input.historyDir, month)} was quarantined; restore its .corrupt-<timestamp> copy, or delete it to abandon those counts, before rebuilding totals`,
        months: months.length,
        days,
        families: totals.families.size,
        lastFrozenDay: totals.lastFrozenDay,
        path: resolveTotalsPath(input.historyDir),
      };
    }
    if (!entry.writable) continue;
    for (const day of Object.keys(entry.days).sort()) {
      const rows = entry.days[day];
      if (!rows || typeof rows !== "object") continue;
      applyDayToTotals(totals, day, rows);
      totals.lastFrozenDay = maxDay(totals.lastFrozenDay, day);
      days += 1;
    }
  }

  const path = resolveTotalsPath(input.historyDir);
  const written = writeJsonAtomic(path, totalsToJson(totals));
  if (!written.ok) {
    return { ok: false, error: written.error, months: months.length, days, families: totals.families.size, lastFrozenDay: totals.lastFrozenDay, path };
  }
  return { ok: true, months: months.length, days, families: totals.families.size, lastFrozenDay: totals.lastFrozenDay, path };
}
