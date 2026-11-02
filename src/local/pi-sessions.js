/**
 * Local token statistics from Pi's own session files.
 *
 * Every assistant message Pi records carries the provider, the model and a
 * usage block, so the tokens a subscription actually burned are already on
 * disk. This module folds those messages into the per-family shape Omarchy's
 * Agents panel renders ("tokens by day", "tokens by model", today's totals),
 * and does it at a bounded cost: the first run streams every session file once,
 * later runs read only the bytes appended since the last scan.
 *
 * Hard rules enforced here:
 *   - session files are opened strictly read-only and never modified;
 *   - nothing but aggregate counts (tokens, prompts, dates, model names) and
 *     the file keys needed to scan incrementally is kept, so no prompt text,
 *     tool output or credential can reach a cache or a record;
 *   - the scan is best-effort: a missing root, an unreadable file or a corrupt
 *     cache degrades to fewer numbers and a warning, never to an exception.
 *
 * Cost model: the cache (`~/.cache/pi-quota/local-sessions.json`) holds, per
 * session file, the (size, mtimeMs, offset) it was read up to plus that file's
 * own aggregates keyed by (family, slot, local day, model). A file that grew is
 * read from `offset`; a file that shrank or was replaced is rescanned; a file
 * that disappeared takes its contribution with it. Today's numbers are always
 * recomputed from the per-day aggregates at report time, so a cache written
 * yesterday still answers "today" correctly.
 *
 * Duplicates: a fork or rewind is a new session file, so in principle the same
 * assistant message could be counted twice. Measured on a real store (603 files,
 * 185,626 assistant messages) only 11 message ids appeared in more than one file
 * (0.006%), and none was a copied history. An id index would cost megabytes of
 * memory to correct a handful of tokens, and no bounded window can recognise a
 * fork that replays an old history, so every message is counted once per line
 * read. If Pi ever starts copying whole histories into forks, that overstates
 * usage (the conservative direction) instead of hiding it.
 */

import {
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { FAMILY_BY_PROVIDER, resolveProviderSlot } from "../auth/pi-auth.js";
import { redact } from "../http.js";

/** Version of the cache envelope; a foreign version is a cache miss. */
export const LOCAL_STATS_SCHEMA_VERSION = 1;

/**
 * How long a scan may run before it returns what it has. The /usage extension
 * runs the CLI with a 30 s timeout and a first full scan of ~1.5 GB costs a few
 * seconds, so this leaves room for the quota calls that run beside it.
 */
export const DEFAULT_SCAN_BUDGET_MS = 12_000;

/** Session formats we can fold: only JSONL files, only message entries. */
const SESSION_SUFFIX = ".jsonl";

/** Number of local days "recentDays" carries, oldest first, today last. */
const RECENT_DAYS = 7;

/**
 * @typedef {Object} LocalModelUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadInputTokens
 * @property {number} cacheCreationInputTokens
 */

/**
 * @typedef {Object} LocalAccountStats
 * @property {number} todayTokens   Tokens used by this account today.
 * @property {number} weekTokens    Tokens used by this account in the last 7 local days.
 * @property {number} todayPrompts  Assistant messages from this account today.
 * @property {number} totalPrompts  Assistant messages from this account, all time.
 * @property {number} totalTokens   Tokens used by this account, all time.
 */

/**
 * The Omarchy-shaped local statistics for one family, plus the per-account
 * breakdown pi's renderers use next to each account line.
 *
 * @typedef {Object} LocalFamilyStats
 * @property {true} hasLocalStats
 * @property {true} hasPromptStats
 * @property {number} todayPrompts
 * @property {number} todaySessions
 * @property {number} todayTotalTokens
 * @property {Record<string, number>} todayTokensByModel
 * @property {Record<string, number>} weekTokensByModel  Same, over the last 7 local days.
 * @property {Array<{ date: string, messageCount: number }>} recentDays
 * @property {number} totalPrompts
 * @property {number} totalSessions
 * @property {number} activeDays
 * @property {string[]} activeDates
 * @property {Record<string, LocalModelUsage>} modelUsage
 * @property {Record<string, LocalAccountStats>} byAccount
 */

/**
 * Options for a local-stats scan, as accepted by the engine's `localStats` option.
 *
 * @typedef {Object} LocalStatsOptions
 * @property {string[]} [roots]        Session roots to scan; overrides the Pi/omp defaults.
 * @property {string} [cachePath]      Scan cache location; overrides ~/.cache/pi-quota/local-sessions.json.
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [home]
 * @property {number} [now]            Report time; decides which local day is "today".
 * @property {number} [budgetMs]       Wall-clock budget for this scan.
 * @property {() => number} [clock]    Time source; tests inject one to drive the budget.
 */

/**
 * One session file's cache entry.
 *
 * `offset` is the byte offset of the first byte that is not part of a complete
 * line (end of file when the last line ended with a newline). `complete` is
 * false when the scan budget stopped the read mid-file; the next run continues
 * from `offset` instead of assuming the file is finished.
 *
 * @typedef {Object} SessionFileEntry
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} ino       Identity of the file, so a replacement that is
 *                              larger than the old one is rescanned instead of
 *                              read from a stale offset. 0 when unavailable.
 * @property {number} offset
 * @property {boolean} complete
 * @property {Record<string, Array<[string, string, string, number, number, number, number, number]>>} days
 */

/**
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} home
 * @returns {string}
 */
function cacheHome(env, home) {
  return env.XDG_CACHE_HOME || join(home ?? homedir(), ".cache");
}

/**
 * Where the per-file scan cache lives. Same directory as the report cache, so
 * `--clear-cache` semantics and the documented filesystem boundary hold.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveLocalStatsCachePath(options = {}) {
  const env = options.env ?? process.env;
  return join(cacheHome(env, options.home), "pi-quota", "local-sessions.json");
}

/**
 * Session roots to scan, in the order Pi itself writes them:
 *   - `$PI_CODING_AGENT_DIR/sessions` when the env var is set;
 *   - `~/.pi/agent/sessions` always;
 *   - `~/.omp/agent/sessions` when the omp fork is installed.
 *
 * Only directories that exist are returned, so a machine without Pi simply
 * reports no local statistics instead of a warning.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string[]}
 */
export function resolveSessionRoots(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  /** @type {string[]} */
  const candidates = [];
  if (env.PI_CODING_AGENT_DIR) candidates.push(join(resolve(env.PI_CODING_AGENT_DIR), "sessions"));
  candidates.push(join(home, ".pi", "agent", "sessions"));
  candidates.push(join(home, ".omp", "agent", "sessions"));

  /** @type {string[]} */
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (statSync(candidate).isDirectory()) roots.push(candidate);
    } catch {
      // Missing root: not an error, just nothing to scan there.
    }
  }
  return roots;
}

/**
 * Local calendar date for an epoch value, as YYYY-MM-DD. Dates are local
 * because the panel draws a local week and calls the last row "Today".
 *
 * @param {number} ms
 * @returns {string}
 */
export function localDayKey(ms) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * @param {number} now
 * @param {number} count
 * @returns {string[]} Oldest first, today last.
 */
function recentLocalDates(now, count) {
  const cursor = new Date(now);
  // Noon keeps the walk away from DST midnights, where "one day back" can land
  // on the same calendar date.
  cursor.setHours(12, 0, 0, 0);
  /** @type {string[]} */
  const dates = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - offset);
    dates.push(localDayKey(date.getTime()));
  }
  return dates;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function modelName(value) {
  if (typeof value !== "string") return "unknown";
  const text = value.trim().replace(/[\u0000-\u001f]/g, "");
  return text === "" ? "unknown" : text.slice(0, 120);
}

/**
 * Map a message onto a quota family and account slot.
 *
 * Pi's own provider id is authoritative: it is the only thing that identifies a
 * numbered sibling (`opencode-go-7`). The `api` string is the fallback Pi's
 * Omarchy collector uses for Codex, generalised: it only ever names a base
 * provider, never a slot.
 *
 * @param {unknown} provider
 * @param {unknown} api
 * @returns {{ family: string, slot: string | null } | null}
 */
function familyForMessage(provider, api) {
  const direct = resolveProviderSlot(typeof provider === "string" ? provider : "");
  if (direct) return { family: direct.family, slot: direct.slot };
  if (typeof api !== "string" || api === "") return null;
  for (const base of Object.keys(FAMILY_BY_PROVIDER)) {
    if (api === base || api.startsWith(`${base}-`) || api.startsWith(`${base}:`)) {
      const resolved = resolveProviderSlot(base);
      if (resolved) return { family: resolved.family, slot: resolved.slot };
    }
  }
  return null;
}

/**
 * Timestamp of a message entry. Pi writes an ISO string on the entry and epoch
 * milliseconds on the message; second-epoch values are accepted because a
 * hand-written or imported session can carry them.
 *
 * @param {Record<string, any>} entry
 * @param {number} fallback
 * @returns {number}
 */
function entryTimeMs(entry, fallback) {
  const candidates = [entry.timestamp, entry.message?.timestamp];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate > 1e11 ? candidate : candidate * 1000;
    }
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fallback;
}

/**
 * Parse one session line into a usage record, or null when the line is not an
 * assistant message this module counts.
 *
 * A message with no tokens at all is not a prompt: Pi records aborted turns and
 * provider errors this way, and counting them would inflate "today's prompts"
 * without adding a single token. Omarchy's collector skips them for the same
 * reason. When only `totalTokens` is present, it is attributed to input, which
 * is how the panel's own totals stay non-zero.
 *
 * @param {string} line
 * @param {number} now
 * @returns {{ day: string, family: string, slot: string, model: string, input: number, output: number, cacheRead: number, cacheWrite: number } | null}
 */
export function usageFromLine(line, now = Date.now()) {
  // A cheap pre-filter before JSON.parse: the session files are ~1.5 GB and
  // most lines are custom/context entries that can never be an assistant
  // message. Safe because an assistant message always serializes the literal.
  if (!line.includes('"assistant"')) return null;

  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || entry.type !== "message") return null;
  const message = entry.message;
  if (!message || message.role !== "assistant") return null;
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const resolved = familyForMessage(message.provider, message.api);
  if (!resolved) return null;

  let input = count(usage.input);
  let output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  if (input + output + cacheRead + cacheWrite === 0) {
    const reported = count(usage.totalTokens);
    if (reported === 0) return null;
    input = reported;
  }

  return {
    day: localDayKey(entryTimeMs(entry, now)),
    family: resolved.family,
    slot: resolved.slot ?? "",
    model: modelName(message.model),
    input,
    output,
    cacheRead,
    cacheWrite,
  };
}

/**
 * Per-file day aggregates while scanning: day -> key -> tuple.
 * The tuple is the serialized form `[family, slot, model, input, output,
 * cacheRead, cacheWrite, prompts]`, which keeps the cache compact.
 *
 * @typedef {Map<string, Map<string, [string, string, string, number, number, number, number, number]>>} DaysMap
 */

/**
 * @returns {DaysMap}
 */
function emptyDays() {
  return new Map();
}

/**
 * @param {DaysMap} days
 * @param {NonNullable<ReturnType<typeof usageFromLine>>} usage
 */
function addUsage(days, usage) {
  let bucket = days.get(usage.day);
  if (!bucket) {
    bucket = new Map();
    days.set(usage.day, bucket);
  }
  const key = `${usage.family}\u0000${usage.slot}\u0000${usage.model}`;
  const tuple = bucket.get(key);
  if (tuple) {
    tuple[3] += usage.input;
    tuple[4] += usage.output;
    tuple[5] += usage.cacheRead;
    tuple[6] += usage.cacheWrite;
    tuple[7] += 1;
    return;
  }
  bucket.set(key, [usage.family, usage.slot, usage.model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, 1]);
}

/**
 * @param {DaysMap} days
 * @returns {SessionFileEntry["days"]}
 */
function encodeDays(days) {
  /** @type {SessionFileEntry["days"]} */
  const encoded = {};
  for (const [day, bucket] of days) encoded[day] = Array.from(bucket.values());
  return encoded;
}

/**
 * @param {unknown} raw
 * @returns {DaysMap}
 */
function decodeDays(raw) {
  const days = emptyDays();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return days;
  for (const [day, tuples] of Object.entries(raw)) {
    if (!Array.isArray(tuples)) continue;
    const bucket = new Map();
    for (const tuple of tuples) {
      if (!Array.isArray(tuple) || tuple.length < 8) continue;
      const [family, slot, model] = tuple;
      if (typeof family !== "string" || typeof slot !== "string" || typeof model !== "string") continue;
      const numbers = [tuple[3], tuple[4], tuple[5], tuple[6], tuple[7]].map(count);
      bucket.set(`${family}\u0000${slot}\u0000${model}`, [
        family,
        slot,
        model,
        numbers[0],
        numbers[1],
        numbers[2],
        numbers[3],
        numbers[4],
      ]);
    }
    if (bucket.size > 0) days.set(day, bucket);
  }
  return days;
}

/**
 * Stream one session file from `startOffset`, handing every complete line to
 * `onLine` and stopping early when `shouldStop` asks.
 *
 * The file is sliced at the newline byte (0x0A), which cannot occur inside a
 * multi-byte UTF-8 sequence, so decoding per complete line is safe. The
 * returned `offset` points at the first byte not part of a processed line,
 * which is exactly where the next incremental run must resume.
 *
 * @param {{
 *   path: string,
 *   startOffset: number,
 *   onLine: (line: string) => void,
 *   shouldStop?: () => boolean,
 * }} input
 * @returns {Promise<{ offset: number, aborted: boolean }>}
 */
async function readLines(input) {
  const stream = createReadStream(input.path, { start: input.startOffset, highWaterMark: 1 << 20 });
  /** @type {Buffer | null} */
  let pending = null;
  let consumed = 0;
  let aborted = false;
  let newlineSeen = 0;

  try {
    for await (const chunk of stream) {
      const buffer = pending && pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      pending = null;
      let cursor = 0;
      let newline = buffer.indexOf(10, cursor);
      while (newline !== -1) {
        if (newline > cursor) input.onLine(buffer.toString("utf8", cursor, newline));
        consumed += newline - cursor + 1;
        cursor = newline + 1;
        newlineSeen += 1;
        // Checking the clock every 16k lines keeps a single huge file inside
        // the budget without calling Date.now() per line.
        if ((newlineSeen & 0x3fff) === 0 && input.shouldStop?.()) {
          aborted = true;
          break;
        }
        newline = buffer.indexOf(10, cursor);
      }
      if (aborted) break;
      pending = cursor < buffer.length ? Buffer.from(buffer.subarray(cursor)) : null;
    }
  } finally {
    // Breaking out of `for await` destroys the stream; this also covers a throw
    // from onLine.
    stream.destroy();
  }

  return { offset: input.startOffset + consumed, aborted };
}

/**
 * Read one session file into day aggregates.
 *
 * @param {{
 *   path: string,
 *   startOffset: number,
 *   existingDays: DaysMap,
 *   now: number,
 *   shouldStop: () => boolean,
 * }} input
 * @returns {Promise<{ days: DaysMap, offset: number, complete: boolean }>}
 */
async function scanFile(input) {
  const days = input.existingDays;
  const result = await readLines({
    path: input.path,
    startOffset: input.startOffset,
    shouldStop: input.shouldStop,
    onLine: (line) => {
      const usage = usageFromLine(line, input.now);
      if (usage) addUsage(days, usage);
    },
  });
  return { days, offset: result.offset, complete: !result.aborted };
}

/**
 * @param {string[]} roots
 * @returns {string[]}
 */
function listSessionFiles(roots) {
  /** @type {string[]} */
  const files = [];
  for (const root of roots) {
    /** @type {Array<[string, import("node:fs").Dirent[]]>} */
    const stack = [];
    try {
      stack.push([root, readdirSync(root, { withFileTypes: true })]);
    } catch {
      continue;
    }
    while (stack.length > 0) {
      const [dir, entries] = /** @type {[string, import("node:fs").Dirent[]]} */ (stack.pop());
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          try {
            stack.push([full, readdirSync(full, { withFileTypes: true })]);
          } catch {
            // An unreadable directory only hides its own sessions.
          }
        } else if (entry.isFile() && entry.name.endsWith(SESSION_SUFFIX)) {
          files.push(full);
        }
      }
    }
  }
  return files.sort();
}

/**
 * Read the cache envelope. A missing, corrupt or foreign-shaped file is a cache
 * miss (a full rescan), never a crash: the cache is an optimization, not state
 * the numbers depend on.
 *
 * @param {string} path
 * @returns {{ files: Record<string, SessionFileEntry>, hit: boolean }}
 */
function readCacheFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { files: {}, hit: false };
  }
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== LOCAL_STATS_SCHEMA_VERSION) {
    return { files: {}, hit: false };
  }
  if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    return { files: {}, hit: false };
  }

  /** @type {Record<string, SessionFileEntry>} */
  const files = {};
  for (const [file, value] of Object.entries(parsed.files)) {
    if (!value || typeof value !== "object") continue;
    const entry = /** @type {Record<string, unknown>} */ (value);
    if (typeof entry.size !== "number" || !Number.isFinite(entry.size)) continue;
    if (typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs)) continue;
    if (typeof entry.offset !== "number" || !Number.isFinite(entry.offset)) continue;
    if (!entry.days || typeof entry.days !== "object" || Array.isArray(entry.days)) continue;
    files[file] = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ino: typeof entry.ino === "number" && Number.isFinite(entry.ino) ? entry.ino : 0,
      offset: Math.max(0, entry.offset),
      complete: entry.complete !== false,
      days: /** @type {SessionFileEntry["days"]} */ (entry.days),
    };
  }
  return { files, hit: true };
}

/**
 * @param {string} path
 * @param {Record<string, SessionFileEntry>} files
 * @returns {{ ok: boolean, error?: string }}
 */
function writeCacheFile(path, files) {
  const payload = `${JSON.stringify({ schemaVersion: LOCAL_STATS_SCHEMA_VERSION, files })}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, payload, { encoding: "utf-8", mode: 0o600 });
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    rmSync(temporary, { force: true });
    return { ok: false, error: redact(/** @type {{ message?: string }} */ (error)?.message ?? String(error)) };
  }
}

/**
 * @param {string} slot
 * @returns {number}
 */
function slotOrder(slot) {
  if (slot === "") return -1;
  const numeric = Number.parseInt(slot, 10);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

/**
 * Fold every cached file's aggregates into the per-family statistics the
 * Omarchy panel and the /usage panel read. Today-dependent fields are derived
 * here, from the per-day aggregates, never stored as "today".
 *
 * @param {Record<string, SessionFileEntry>} files
 * @param {{ now?: number }} [options]
 * @returns {Record<string, LocalFamilyStats>}
 */
export function buildLocalStats(files, options = {}) {
  const now = options.now ?? Date.now();
  const today = localDayKey(now);
  const recentDates = recentLocalDates(now, RECENT_DAYS);

  /** @type {Map<string, { prompts: number, sessions: Set<string>, activeDates: Set<string>, dayTokens: Map<string, number>, dayPrompts: Map<string, number>, daySessions: Map<string, Set<string>>, dayModels: Map<string, Map<string, number>>, models: Map<string, LocalModelUsage>, accounts: Map<string, { dayTokens: Map<string, number>, dayPrompts: Map<string, number>, prompts: number, tokens: number }> }>} */
  const families = new Map();

  for (const [file, entry] of Object.entries(files ?? {})) {
    if (!entry || !entry.days) continue;
    for (const [day, tuples] of Object.entries(entry.days)) {
      if (!Array.isArray(tuples) || tuples.length === 0) continue;
      for (const tuple of tuples) {
        if (!Array.isArray(tuple) || tuple.length < 8) continue;
        const [family, slot, model] = tuple;
        if (typeof family !== "string" || typeof slot !== "string" || typeof model !== "string") continue;
        const input = count(tuple[3]);
        const output = count(tuple[4]);
        const cacheRead = count(tuple[5]);
        const cacheWrite = count(tuple[6]);
        const prompts = count(tuple[7]);
        const tokens = input + output + cacheRead + cacheWrite;
        if (prompts === 0 && tokens === 0) continue;

        let acc = families.get(family);
        if (!acc) {
          acc = {
            prompts: 0,
            sessions: new Set(),
            activeDates: new Set(),
            dayTokens: new Map(),
            dayPrompts: new Map(),
            daySessions: new Map(),
            dayModels: new Map(),
            models: new Map(),
            accounts: new Map(),
          };
          families.set(family, acc);
        }

        acc.prompts += prompts;
        acc.activeDates.add(day);
        acc.sessions.add(file);

        acc.dayTokens.set(day, (acc.dayTokens.get(day) ?? 0) + tokens);
        acc.dayPrompts.set(day, (acc.dayPrompts.get(day) ?? 0) + prompts);
        const daySessions = acc.daySessions.get(day) ?? new Set();
        daySessions.add(file);
        acc.daySessions.set(day, daySessions);
        const dayModels = acc.dayModels.get(day) ?? new Map();
        dayModels.set(model, (dayModels.get(model) ?? 0) + tokens);
        acc.dayModels.set(day, dayModels);

        const known = acc.models.get(model);
        if (known) {
          known.inputTokens += input;
          known.outputTokens += output;
          known.cacheReadInputTokens += cacheRead;
          known.cacheCreationInputTokens += cacheWrite;
        } else {
          acc.models.set(model, {
            inputTokens: input,
            outputTokens: output,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheWrite,
          });
        }

        const account = acc.accounts.get(slot) ?? { dayTokens: new Map(), dayPrompts: new Map(), prompts: 0, tokens: 0 };
        account.dayTokens.set(day, (account.dayTokens.get(day) ?? 0) + tokens);
        account.dayPrompts.set(day, (account.dayPrompts.get(day) ?? 0) + prompts);
        account.prompts += prompts;
        account.tokens += tokens;
        acc.accounts.set(slot, account);
      }
    }
  }

  /** @type {Record<string, LocalFamilyStats>} */
  const byFamily = {};
  for (const [family, acc] of families) {
    if (acc.prompts === 0) continue;

    /** @type {Record<string, LocalModelUsage>} */
    const modelUsage = {};
    const models = Array.from(acc.models.entries()).sort((a, b) => {
      const totalOf = (bucket) => bucket.inputTokens + bucket.outputTokens + bucket.cacheReadInputTokens + bucket.cacheCreationInputTokens;
      const byTotal = totalOf(b[1]) - totalOf(a[1]);
      return byTotal !== 0 ? byTotal : a[0].localeCompare(b[0]);
    });
    for (const [model, usage] of models) modelUsage[model] = { ...usage };

    const todayModels = acc.dayModels.get(today) ?? new Map();
    /** @type {Record<string, number>} */
    const todayTokensByModel = {};
    for (const [model, tokens] of Array.from(todayModels.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      todayTokensByModel[model] = tokens;
    }

    // The panel ranks models by what was used this week, not by a model that
    // dominated months ago.
    const weekModels = new Map();
    for (const date of recentDates) {
      for (const [model, tokens] of acc.dayModels.get(date) ?? []) {
        weekModels.set(model, (weekModels.get(model) ?? 0) + tokens);
      }
    }
    /** @type {Record<string, number>} */
    const weekTokensByModel = {};
    for (const [model, tokens] of Array.from(weekModels.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      weekTokensByModel[model] = tokens;
    }

    /** @type {Record<string, LocalAccountStats>} */
    const byAccount = {};
    const slots = Array.from(acc.accounts.keys()).sort((a, b) => slotOrder(a) - slotOrder(b) || a.localeCompare(b));
    for (const slot of slots) {
      const account = acc.accounts.get(slot);
      if (!account) continue;
      const weekTokens = recentDates.reduce((sum, date) => sum + (account.dayTokens.get(date) ?? 0), 0);
      byAccount[slot === "" ? "#1" : `#${slot}`] = {
        todayTokens: account.dayTokens.get(today) ?? 0,
        weekTokens,
        todayPrompts: account.dayPrompts.get(today) ?? 0,
        totalPrompts: account.prompts,
        totalTokens: account.tokens,
      };
    }

    byFamily[family] = {
      hasLocalStats: true,
      hasPromptStats: true,
      todayPrompts: acc.dayPrompts.get(today) ?? 0,
      todaySessions: acc.daySessions.get(today)?.size ?? 0,
      todayTotalTokens: acc.dayTokens.get(today) ?? 0,
      todayTokensByModel,
      weekTokensByModel,
      recentDays: recentDates.map((date) => ({ date, messageCount: acc.dayTokens.get(date) ?? 0 })),
      totalPrompts: acc.prompts,
      totalSessions: acc.sessions.size,
      activeDays: acc.activeDates.size,
      activeDates: Array.from(acc.activeDates).sort(),
      modelUsage,
      byAccount,
    };
  }
  return byFamily;
}

/**
 * Scan Pi's session files and fold them into local statistics.
 *
 * Never throws. Everything unexpected (unreadable file, unwritable cache)
 * becomes a warning; the numbers simply cover fewer sessions.
 *
 * @param {{
 *   roots?: string[],
 *   cachePath?: string,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   now?: number,
 *   budgetMs?: number,
 *   clock?: () => number,
 * }} [options]
 * @returns {Promise<{
 *   byFamily: Record<string, LocalFamilyStats>,
 *   warnings: string[],
 *   scan: { files: number, scanned: number, reused: number, bytesRead: number, durationMs: number, partial: boolean, budgetMs: number },
 * }>}
 */
export async function collectLocalStats(options = {}) {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const now = options.now ?? Date.now();
  const budgetMs = Number.isFinite(options.budgetMs) ? /** @type {number} */ (options.budgetMs) : DEFAULT_SCAN_BUDGET_MS;
  const roots = options.roots ?? resolveSessionRoots(options);
  const cachePath = options.cachePath ?? resolveLocalStatsCachePath(options);
  /** @type {string[]} */
  const warnings = [];

  const overBudget = () => clock() - startedAt > budgetMs;
  const cached = readCacheFile(cachePath);
  const listen = listSessionFiles(roots);
  const listedSet = new Set(listen);

  /** @type {Record<string, SessionFileEntry>} */
  const next = {};
  let changed = !cached.hit;
  let scanned = 0;
  let reused = 0;
  let bytesRead = 0;
  let partial = overBudget();

  for (const path of listen) {
    if (!partial && overBudget()) partial = true;
    if (partial) break;

    let stats;
    try {
      stats = statSync(path);
    } catch (error) {
      if (cached.files[path]) next[path] = cached.files[path];
      warnings.push(`local token stats: could not stat ${path}: ${redact(/** @type {{ message?: string }} */ (error)?.message)}`);
      continue;
    }

    // Reuse only a file that was read to its last complete line at exactly
    // this size and mtime. `offset < size` means a trailing partial line (or
    // bytes that arrived after the read reached EOF), and those must be
    // re-examined before the run can call the file unchanged.
    const previous = cached.files[path];
    if (
      previous &&
      previous.size === stats.size &&
      previous.mtimeMs === stats.mtimeMs &&
      previous.ino === (stats.ino ?? 0) &&
      previous.complete &&
      previous.offset === previous.size
    ) {
      next[path] = previous;
      reused += 1;
      continue;
    }

    let days;
    let offset;
    let complete;
    try {
      const reset = !previous || previous.ino !== (stats.ino ?? 0) || stats.size < previous.offset;
      const startOffset = reset ? 0 : previous.offset;
      const result = await scanFile({
        path,
        startOffset,
        existingDays: reset ? emptyDays() : decodeDays(previous.days),
        now,
        shouldStop: overBudget,
      });
      days = result.days;
      offset = result.offset;
      complete = result.complete;
      bytesRead += offset - startOffset;
    } catch (error) {
      // A transient read error keeps the last known contribution instead of
      // silently deleting history for that session.
      if (previous) next[path] = previous;
      warnings.push(`local token stats: could not read ${path}: ${redact(/** @type {{ message?: string }} */ (error)?.message)}`);
      continue;
    }

    let finalStats = stats;
    if (complete) {
      try {
        finalStats = statSync(path);
      } catch {
        // Keep the pre-scan stat; the next run detects the change.
      }
    }
    next[path] = {
      size: finalStats.size,
      mtimeMs: finalStats.mtimeMs,
      ino: finalStats.ino ?? 0,
      offset,
      complete,
      days: encodeDays(days),
    };
    changed = true;
    scanned += 1;
    if (!complete) {
      partial = true;
      break;
    }
  }

  // Files the budget skipped keep their previous entry; files that are gone
  // lose theirs (and their contribution) on this run.
  for (const path of listen) {
    if (!next[path] && cached.files[path]) next[path] = cached.files[path];
  }
  for (const path of Object.keys(cached.files)) {
    if (!listedSet.has(path)) changed = true;
  }

  if (changed) {
    const written = writeCacheFile(cachePath, next);
    if (!written.ok) {
      warnings.push(`local token stats: could not write the scan cache at ${cachePath}: ${written.error}`);
    }
  }

  return {
    byFamily: buildLocalStats(next, { now }),
    warnings,
    scan: {
      files: listen.length,
      scanned,
      reused,
      bytesRead,
      durationMs: clock() - startedAt,
      partial,
      budgetMs,
    },
  };
}
