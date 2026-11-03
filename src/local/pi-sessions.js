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
 * Two stores, two lifetimes:
 *   - the disposable per-file cache under `~/.cache/pi-quota/local-sessions.json`
 *     holds the (size, mtimeMs, inode, offset) of every session file plus that
 *     file's aggregates for OPEN days only (normally just today), so an append
 *     is read once and nothing is ever parsed twice;
 *   - the durable history under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage/`
 *     (see history.js) holds every closed day. Freezing is one-way: a frozen
 *     day is never recomputed from a rescan, never rewritten by a session
 *     deletion and never lost with the cache.
 *
 * Hard rules enforced here:
 *   - session files are opened strictly read-only and never modified;
 *   - nothing but aggregate counts (tokens, prompts, dates, model names) and
 *     the file keys needed to scan incrementally reaches a cache, a record or
 *     the report, so no prompt text, tool output or credential is ever stored;
 *   - the scan is best-effort: a missing root, an unreadable file or a corrupt
 *     cache/history degrades to fewer numbers and a warning, never to a
 *     provider failure.
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

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { FAMILY_BY_PROVIDER, resolveProviderSlot } from "../auth/pi-auth.js";
import { redact } from "../http.js";
import {
  accountLabel,
  acquireHistoryLock,
  addToModels,
  applyDurable,
  bucketMessages,
  bucketTokens,
  emptyBucket,
  emptyTotals,
  familyRowMessages,
  familyRowTokens,
  loadTotals,
  loadWindowDays,
  refreshHistoryLock,
  releaseHistoryLock,
  resolveHistoryDir,
} from "./history.js";

/** Version of the disposable per-file cache; a foreign version is a cache miss. */
export const LOCAL_STATS_SCHEMA_VERSION = 2;

/**
 * How long a scan may run before it returns what it has. The /usage extension
 * runs the CLI with a 30 s timeout and a first full scan of ~1.5 GB costs a few
 * seconds, so this leaves room for the quota calls that run beside it. A
 * truncated scan never freezes a day: history is written only from complete runs.
 */
export const DEFAULT_SCAN_BUDGET_MS = 12_000;

/** Session formats we can fold: only JSONL files, only message entries. */
const SESSION_SUFFIX = ".jsonl";

/** Number of local days "recentDays" carries, oldest first, today last. */
const RECENT_DAYS = 7;

/**
 * @typedef {import("./history.js").Bucket} Bucket
 * @typedef {import("./history.js").DayRows} DayRows
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
 * @property {number} totalSessions   Session-days: a session spanning midnight counts once per day.
 * @property {number} activeDays
 * @property {string[]} activeDates
 * @property {Record<string, { inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number }>} modelUsage
 * @property {Record<string, { todayTokens: number, weekTokens: number, todayPrompts: number, totalPrompts: number, totalTokens: number, todayTokensByModel: Record<string, number> }>} byAccount
 */

/**
 * How the scan went, for `localStatsMeta` in the report.
 *
 * @typedef {Object} LocalScanMeta
 * @property {number} files      Session files found.
 * @property {number} scanned    Files (re)read in this run.
 * @property {number} reused     Files whose cached offsets still matched.
 * @property {number} bytesRead  Bytes parsed in this run.
 * @property {number} durationMs Scan wall time.
 * @property {boolean} partial   The budget stopped the scan; nothing was frozen.
 * @property {number} budgetMs   The budget that applied.
 * @property {number} frozenDays Days moved into the durable history by this run.
 * @property {boolean} locked    Another run held the history lock; nothing was written.
 */

/**
 * Options for a local-stats scan, as accepted by the engine's `localStats` option.
 *
 * @typedef {Object} LocalStatsOptions
 * @property {string[]} [roots]        Session roots to scan; overrides the Pi/omp defaults.
 * @property {string} [cachePath]      Scan cache location; overrides ~/.cache/pi-quota/local-sessions.json.
 * @property {string} [historyDir]     Durable history directory; overrides ${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage.
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
 * from `offset` instead of assuming the file is finished. `days` holds open
 * days only: a frozen day is removed from the entry once the durable write
 * succeeded, so a rescan can never recompute it.
 *
 * @typedef {Object} SessionFileEntry
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} ino
 * @property {number} offset
 * @property {boolean} complete
 * @property {string} [fingerprint] Copy fingerprint of the content at `size`
 *                                  (see fingerprintFile), only set after a full read.
 * @property {string} [dedupedBy]    Path of the file this one was verified to be
 *                                  a byte-identical copy of; it holds no rows of
 *                                  its own while that path exists.
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
 * Where the disposable per-file scan cache lives.
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
  if (env.PI_CODING_AGENT_DIR) candidates.push(join(env.PI_CODING_AGENT_DIR, "sessions"));
  candidates.push(join(home, ".pi", "agent", "sessions"));
  candidates.push(join(home, ".omp", "agent", "sessions"));

  /** @type {string[]} */
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    let key = candidate;
    try {
      // Two roots can name the same directory: `PI_CODING_AGENT_DIR` may point
      // at a symlink of `~/.pi/agent`, and scanning that twice would count
      // every message twice.
      key = realpathSync(candidate);
      if (seen.has(key)) continue;
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      // Missing root: not an error, just nothing to scan there.
      continue;
    }
    seen.add(key);
    roots.push(candidate);
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
 * Explicit roots bypass `resolveSessionRoots`, so de-duplicate them by real path
 * here too: a caller that names the same store twice must not double count.
 *
 * @param {string[]} roots
 * @returns {string[]}
 */
function dedupeRoots(roots) {
  /** @type {string[]} */
  const unique = [];
  const seen = new Set();
  for (const root of roots) {
    let key = root;
    try {
      key = realpathSync(root);
    } catch {
      // Keep the unresolved path; listSessionFiles skips missing roots.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }
  return unique;
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
  const output = count(usage.output);
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
 * Per-file open-day aggregates while scanning: day -> key -> tuple.
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
 * Read one session file into open-day aggregates, routing each message.
 *
 * @param {{
 *   path: string,
 *   startOffset: number,
 *   days: DaysMap,
 *   now: number,
 *   onUsage: (usage: NonNullable<ReturnType<typeof usageFromLine>>) => void,
 *   shouldStop: () => boolean,
 * }} input
 * @returns {Promise<{ offset: number, complete: boolean }>}
 */
async function scanFile(input) {
  const result = await readLines({
    path: input.path,
    startOffset: input.startOffset,
    shouldStop: input.shouldStop,
    onLine: (line) => {
      const usage = usageFromLine(line, input.now);
      if (usage) input.onUsage(usage);
    },
  });
  return { offset: result.offset, complete: !result.aborted };
}

/** Bytes hashed from each end of a session file for the copy fingerprint. */
const FINGERPRINT_BYTES = 32 * 1024;

/**
 * Fingerprint a session file as (size, first 32 KB, last 32 KB).
 *
 * This exists to recognise a byte-identical copy of a session that is already
 * counted: a `cp`, a restored backup or a sync tool would otherwise add the
 * same messages a second time, and for today's messages that is a real
 * overcount (a frozen day is protected by the frozen-day rule instead).
 *
 * Only two small reads, so a duplicate 240 MB session costs 64 KB rather than
 * a full parse. A *fork* (which copies a prefix and then diverges) has a
 * different size and tail, so it is never mistaken for a copy and never loses
 * the messages it added after forking.
 *
 * @param {string} path
 * @param {number} size
 * @returns {string | null} Hex digest, or null when the file cannot be read.
 */
function fingerprintFile(path, size) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
    if (head.length > 0) readSync(fd, head, 0, head.length, 0);
    const tailLength = Math.min(FINGERPRINT_BYTES, Math.max(0, size - head.length));
    let tail = Buffer.alloc(0);
    if (tailLength > 0) {
      tail = Buffer.alloc(tailLength);
      readSync(fd, tail, 0, tailLength, size - tailLength);
    }
    const hash = createHash("sha256");
    hash.update(`${size}\u0000`);
    hash.update(head);
    hash.update(tail);
    return hash.digest("hex").slice(0, 32);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The fingerprint is an optimization; a close failure changes nothing.
      }
    }
  }
}

/**
 * Full-content comparison of two session files, streamed in 1 MB chunks.
 *
 * Only called when a cheap fingerprint already matched, so the expensive path is
 * the rare one: a real duplicate. Streams rather than buffering, because the
 * sessions on this machine reach 240 MB.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} size Expected size of both.
 * @returns {boolean}
 */
function sameContent(a, b, size) {
  let left = null;
  let right = null;
  try {
    left = openSync(a, "r");
    right = openSync(b, "r");
    const leftBuffer = Buffer.alloc(1 << 20);
    const rightBuffer = Buffer.alloc(1 << 20);
    let offset = 0;
    while (offset < size) {
      const wanted = Math.min(leftBuffer.length, size - offset);
      const leftRead = readSync(left, leftBuffer, 0, wanted, offset);
      const rightRead = readSync(right, rightBuffer, 0, wanted, offset);
      if (leftRead !== rightRead) return false;
      if (leftBuffer.compare(rightBuffer, 0, rightRead, 0, leftRead) !== 0) return false;
      if (leftRead <= 0) break;
      offset += leftRead;
    }
    return true;
  } catch {
    // An unreadable candidate is not a duplicate: counting it twice is the safer
    // error, since dropping a session silently loses tokens.
    return false;
  } finally {
    for (const fd of [left, right]) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Closing is best-effort.
        }
      }
    }
  }
}

/**
 * @param {string[]} roots
 * @returns {string[]}
 */
function listSessionFiles(roots) {
  /** @type {string[]} */
  const files = [];
  const seen = new Set();
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
          // Same file through two roots (symlinked session dirs, a shared
          // store) must be read once per run.
          let key = full;
          try {
            key = realpathSync(full);
          } catch {
            // A vanished file is caught by statSync below and skipped.
          }
          if (seen.has(key)) continue;
          seen.add(key);
          files.push(full);
        }
      }
    }
  }
  return files.sort();
}

/**
 * Read the disposable cache envelope. A missing, corrupt or foreign-shaped file
 * is a cache miss (a full rescan), never a crash.
 *
 * @param {string} path
 * @returns {{ files: Record<string, SessionFileEntry>, hit: boolean, pendingLate: DaysMap }}
 */
function readCacheFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { files: {}, hit: false, historyWatermark: "", pendingLate: emptyDays() };
  }
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== LOCAL_STATS_SCHEMA_VERSION) {
    return { files: {}, hit: false, historyWatermark: "", pendingLate: emptyDays() };
  }
  if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    return { files: {}, hit: false, historyWatermark: "", pendingLate: emptyDays() };
  }
  // The last `lastFrozenDay` this cache was written against. An empty rollup
  // next to a non-empty watermark is a lost history, not a fresh one.
  const historyWatermark = typeof parsed.historyWatermark === "string" ? parsed.historyWatermark : "";
  const pendingLate = decodeDays(parsed.pendingLate);

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
      ...(typeof entry.fingerprint === "string" && entry.fingerprint !== "" ? { fingerprint: entry.fingerprint } : {}),
      ...(typeof entry.dedupedBy === "string" && entry.dedupedBy !== "" ? { dedupedBy: entry.dedupedBy } : {}),
      days: /** @type {SessionFileEntry["days"]} */ (entry.days),
    };
  }
  return { files, hit: true, historyWatermark, pendingLate };
}

/**
 * @param {string} path
 * @param {Record<string, SessionFileEntry>} files
 * @param {string} historyWatermark The `lastFrozenDay` this cache is written against.
 * @param {SessionFileEntry["days"]} [pendingLate] Late deltas waiting for an unreadable month.
 * @returns {{ ok: boolean, error?: string }}
 */
function writeCacheFile(path, files, historyWatermark = "", pendingLate = {}) {
  // `historyWatermark` records which `lastFrozenDay` this cache belongs to, so a
  // later run can tell a lost rollup from a fresh install. Pending late rows are
  // aggregate deltas retained until their month can be updated.
  const payload = `${JSON.stringify({ schemaVersion: LOCAL_STATS_SCHEMA_VERSION, historyWatermark, files, ...(Object.keys(pendingLate).length > 0 ? { pendingLate } : {}) })}\n`;
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
 * Fold every session file's open-day tuples into one `DayRows` per day. Session
 * counts are distinct files, which is what "today: N sessions" means.
 *
 * @param {Record<string, SessionFileEntry>} files
 * @returns {Record<string, DayRows>}
 */
function buildOpenRows(files) {
  /** @type {Map<string, Map<string, { files: Set<string>, slots: Map<string, { files: Set<string>, models: Map<string, Bucket> }> }>>} */
  const days = new Map();
  for (const [file, entry] of Object.entries(files ?? {})) {
    for (const [day, tuples] of Object.entries(entry.days ?? {})) {
      if (!Array.isArray(tuples) || tuples.length === 0) continue;
      for (const tuple of tuples) {
        if (!Array.isArray(tuple) || tuple.length < 8) continue;
        const [family, slot, model] = tuple;
        if (typeof family !== "string" || typeof slot !== "string" || typeof model !== "string") continue;
        const bucket = {
          input: count(tuple[3]),
          output: count(tuple[4]),
          cacheRead: count(tuple[5]),
          cacheWrite: count(tuple[6]),
          messages: count(tuple[7]),
        };
        if (bucket.messages === 0 && bucketTokens(bucket) === 0) continue;

        const dayMap = days.get(day) ?? new Map();
        days.set(day, dayMap);
        const familyAgg = dayMap.get(family) ?? { files: new Set(), slots: new Map() };
        dayMap.set(family, familyAgg);
        familyAgg.files.add(file);
        const slotAgg = familyAgg.slots.get(slot) ?? { files: new Set(), models: new Map() };
        familyAgg.slots.set(slot, slotAgg);
        slotAgg.files.add(file);
        const known = slotAgg.models.get(model);
        if (known) {
          known.input += bucket.input;
          known.output += bucket.output;
          known.cacheRead += bucket.cacheRead;
          known.cacheWrite += bucket.cacheWrite;
          known.messages += bucket.messages;
        } else {
          slotAgg.models.set(model, { ...bucket });
        }
      }
    }
  }

  /** @type {Record<string, DayRows>} */
  const rows = {};
  for (const [day, families] of days) {
    /** @type {DayRows} */
    const dayRows = {};
    for (const [family, familyAgg] of families) {
      /** @type {Record<string, { sessions: number, models: Record<string, Bucket> }>} */
      const slots = {};
      for (const [slot, slotAgg] of familyAgg.slots) {
        /** @type {Record<string, Bucket>} */
        const models = {};
        for (const [model, bucket] of slotAgg.models) models[model] = { ...bucket };
        slots[slot] = { sessions: slotAgg.files.size, models };
      }
      dayRows[family] = { sessions: familyAgg.files.size, slots };
    }
    rows[day] = dayRows;
  }
  return rows;
}

/**
 * Turn cached, not-yet-applied late deltas into durable-history rows.
 * Session counts stay zero because the original frozen day already counted them.
 *
 * @param {DaysMap} days
 * @returns {Record<string, DayRows>}
 */
function buildLateRows(days) {
  /** @type {Record<string, DayRows>} */
  const rows = {};
  for (const [day, tuples] of days) {
    const dayRows = (rows[day] ??= {});
    for (const tuple of tuples.values()) {
      const [family, slot, model] = tuple;
      const familyRow = (dayRows[family] ??= { sessions: 0, slots: {} });
      const slotRow = (familyRow.slots[slot] ??= { sessions: 0, models: {} });
      const bucket = (slotRow.models[model] ??= emptyBucket());
      bucket.input += count(tuple[3]);
      bucket.output += count(tuple[4]);
      bucket.cacheRead += count(tuple[5]);
      bucket.cacheWrite += count(tuple[6]);
      bucket.messages += count(tuple[7]);
    }
  }
  return rows;
}

/**
 * @param {Map<string, number>} models Token totals by model id.
 * @returns {Record<string, number>}
 */
function tokensByModel(models) {
  /** @type {Array<[string, number]>} */
  const entries = [];
  for (const [model, tokens] of models) {
    if (tokens > 0) entries.push([model, tokens]);
  }
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return Object.fromEntries(entries);
}

/**
 * @param {string} label
 * @returns {number}
 */
function labelOrder(label) {
  // "" is the base entry; "#1" is the old invented label for it, kept so a
  // totals.json written before the fix still sorts first.
  if (label === "" || label === "#1") return -1;
  const numeric = Number.parseInt(String(label).replace(/^#/, ""), 10);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

/**
 * Fold the durable rollup, the frozen days of the last seven days, and the open
 * days into the shape the Omarchy panel and /usage read. Today is always taken
 * from open days; the week prefers the open copy of a day and falls back to the
 * frozen month file, so a crash between a month write and the totals write never
 * double counts.
 *
 * @param {{
 *   totals?: import("./history.js").Totals,
 *   openRows?: Record<string, DayRows>,
 *   windowDays?: Record<string, DayRows>,
 *   now?: number,
 * }} input
 * @returns {Record<string, LocalFamilyStats>}
 */
export function buildLocalStats(input = {}) {
  const now = input.now ?? Date.now();
  const today = localDayKey(now);
  const recentDates = recentLocalDates(now, RECENT_DAYS);
  const openRows = input.openRows ?? {};
  const windowDays = input.windowDays ?? {};
  const totals = input.totals ?? emptyTotals();

  const families = new Set(totals.families.keys());
  for (const rows of Object.values(openRows)) for (const family of Object.keys(rows)) families.add(family);
  for (const rows of Object.values(windowDays)) for (const family of Object.keys(rows)) families.add(family);

  /** @type {Record<string, LocalFamilyStats>} */
  const byFamily = {};
  for (const family of families) {
    const history = totals.families.get(family) ?? null;

    // Open days (normally just today, plus anything a truncated run left open).
    let openPrompts = 0;
    let openSessions = 0;
    const openModels = new Map();
    const openAccounts = new Map();
    const openDates = new Set();
    for (const [day, rows] of Object.entries(openRows)) {
      const familyRow = rows?.[family];
      if (!familyRow) continue;
      openDates.add(day);
      openSessions += count(familyRow.sessions);
      for (const [slot, slotRow] of Object.entries(familyRow.slots ?? {})) {
        const label = accountLabel(slot);
        const account = openAccounts.get(label) ?? { prompts: 0, sessions: 0, models: new Map() };
        account.sessions += count(slotRow.sessions);
        for (const [model, bucket] of Object.entries(slotRow.models ?? {})) {
          addToModels(openModels, model, bucket);
          addToModels(account.models, model, bucket);
          openPrompts += bucketMessages(bucket);
          account.prompts += bucketMessages(bucket);
        }
        openAccounts.set(label, account);
      }
    }

    // The seven-day window: open days override frozen ones.
    const dayTokens = new Map();
    const dayModels = new Map();
    const daySlots = new Map();
    const frozenThrough = totals.lastFrozenDay;
    for (const date of recentDates) {
      // A frozen day belongs to the month file, which carries its late writes;
      // an open day belongs to the cache. Preferring the cache for a frozen day
      // would hide a late append until the day left the window.
      const frozen = frozenThrough !== "" && date <= frozenThrough;
      const rows = frozen ? (windowDays[date] ?? openRows[date]) : (openRows[date] ?? windowDays[date]);
      const familyRow = rows?.[family];
      if (!familyRow) {
        dayTokens.set(date, 0);
        continue;
      }
      dayTokens.set(date, familyRowTokens(familyRow));
      /** @type {Map<string, number>} */
      const models = new Map();
      /** @type {Map<string, { tokens: number, prompts: number }>} */
      const slots = new Map();
      for (const [slot, slotRow] of Object.entries(familyRow.slots ?? {})) {
        const label = accountLabel(slot);
        let tokens = 0;
        let prompts = 0;
        for (const [model, bucket] of Object.entries(slotRow.models ?? {})) {
          const modelTokens = bucketTokens(bucket);
          tokens += modelTokens;
          prompts += bucketMessages(bucket);
          models.set(model, (models.get(model) ?? 0) + modelTokens);
        }
        const known = slots.get(label) ?? { tokens: 0, prompts: 0 };
        known.tokens += tokens;
        known.prompts += prompts;
        slots.set(label, known);
      }
      dayModels.set(date, models);
      daySlots.set(date, slots);
    }

    const todayRows = openRows[today]?.[family] ?? null;
    const todayPrompts = todayRows ? familyRowMessages(todayRows) : 0;
    const todayTotalTokens = todayRows ? familyRowTokens(todayRows) : 0;
    /** @type {Map<string, number>} */
    const todayModels = new Map();
    for (const slotRow of Object.values(todayRows?.slots ?? {})) {
      for (const [model, bucket] of Object.entries(slotRow.models ?? {})) {
        todayModels.set(model, (todayModels.get(model) ?? 0) + bucketTokens(bucket));
      }
    }
    // The same split per account, so the History page can name the model behind
    // an account's live (unfrozen) today row instead of leaving it blank.
    /** @type {Map<string, Map<string, number>>} */
    const todayAccountModels = new Map();
    for (const [slot, slotRow] of Object.entries(todayRows?.slots ?? {})) {
      const label = accountLabel(slot);
      const models = todayAccountModels.get(label) ?? new Map();
      for (const [model, bucket] of Object.entries(slotRow.models ?? {})) {
        models.set(model, (models.get(model) ?? 0) + bucketTokens(bucket));
      }
      todayAccountModels.set(label, models);
    }

    /** @type {Map<string, number>} */
    const weekModels = new Map();
    for (const models of dayModels.values()) {
      for (const [model, tokens] of models) weekModels.set(model, (weekModels.get(model) ?? 0) + tokens);
    }

    /** @type {Map<string, Bucket>} */
    const allModels = new Map();
    for (const [model, bucket] of history?.models ?? []) allModels.set(model, { ...bucket });
    for (const [model, bucket] of openModels) addToModels(allModels, model, bucket);

    const activeDates = new Set(history?.activeDates ?? []);
    for (const date of openDates) activeDates.add(date);

    /** @type {Record<string, { todayTokens: number, weekTokens: number, todayPrompts: number, totalPrompts: number, totalTokens: number }>} */
    const byAccount = {};
    const labels = new Set([...(history?.accounts.keys() ?? []), ...openAccounts.keys()]);
    for (const label of Array.from(labels).sort((a, b) => labelOrder(a) - labelOrder(b))) {
      const historyAccount = history?.accounts.get(label);
      const openAccount = openAccounts.get(label);
      /** @type {Map<string, Bucket>} */
      const accountModels = new Map();
      for (const [model, bucket] of historyAccount?.models ?? []) accountModels.set(model, { ...bucket });
      for (const [model, bucket] of openAccount?.models ?? []) addToModels(accountModels, model, bucket);
      let totalTokens = 0;
      for (const bucket of accountModels.values()) totalTokens += bucketTokens(bucket);
      let weekTokens = 0;
      for (const date of recentDates) weekTokens += daySlots.get(date)?.get(label)?.tokens ?? 0;
      byAccount[label] = {
        todayTokens: daySlots.get(today)?.get(label)?.tokens ?? 0,
        weekTokens,
        todayPrompts: daySlots.get(today)?.get(label)?.prompts ?? 0,
        totalPrompts: (historyAccount?.totalPrompts ?? 0) + (openAccount?.prompts ?? 0),
        totalTokens,
        todayTokensByModel: Object.fromEntries(todayAccountModels.get(label) ?? []),
      };
    }

    const totalPrompts = (history?.totalPrompts ?? 0) + openPrompts;
    if (totalPrompts === 0 && allModels.size === 0) continue;

    /** @type {Record<string, { inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number }>} */
    const modelUsage = {};
    const sortedModels = Array.from(allModels.entries()).sort((a, b) => bucketTokens(b[1]) - bucketTokens(a[1]) || a[0].localeCompare(b[0]));
    for (const [model, bucket] of sortedModels) {
      modelUsage[model] = {
        inputTokens: bucket.input,
        outputTokens: bucket.output,
        cacheReadInputTokens: bucket.cacheRead,
        cacheCreationInputTokens: bucket.cacheWrite,
      };
    }

    byFamily[family] = {
      hasLocalStats: true,
      hasPromptStats: true,
      todayPrompts,
      todaySessions: todayRows ? count(todayRows.sessions) : 0,
      todayTotalTokens,
      todayTokensByModel: tokensByModel(todayModels),
      weekTokensByModel: tokensByModel(weekModels),
      recentDays: recentDates.map((date) => ({ date, messageCount: dayTokens.get(date) ?? 0 })),
      totalPrompts,
      totalSessions: (history?.totalSessions ?? 0) + openSessions,
      activeDays: activeDates.size,
      activeDates: Array.from(activeDates).sort(),
      modelUsage,
      byAccount,
    };
  }
  return byFamily;
}

/**
 * Scan Pi's session files, freeze closed days into the durable history, and fold
 * everything into local statistics.
 *
 * Never throws. Everything unexpected (unreadable file, unwritable cache or
 * history) becomes a warning; the numbers simply cover fewer sessions.
 *
 * @param {{
 *   roots?: string[],
 *   cachePath?: string,
 *   historyDir?: string,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   now?: number,
 *   budgetMs?: number,
 *   clock?: () => number,
 * }} [options]
 * @returns {Promise<{
 *   byFamily: Record<string, LocalFamilyStats>,
 *   warnings: string[],
 *   scan: LocalScanMeta,
 * }>}
 */export async function collectLocalStats(options = {}) {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const now = options.now ?? Date.now();
  const today = localDayKey(now);
  const budgetMs = Number.isFinite(options.budgetMs) ? /** @type {number} */ (options.budgetMs) : DEFAULT_SCAN_BUDGET_MS;
  const roots = dedupeRoots(options.roots ?? resolveSessionRoots(options));
  const cachePath = options.cachePath ?? resolveLocalStatsCachePath(options);
  const historyDir = options.historyDir ?? resolveHistoryDir(options);
  /** @type {string[]} */
  const warnings = [];
  const listen = listSessionFiles(roots);

  /** @type {LocalScanMeta} */
  const emptyScan = {
    files: listen.length,
    scanned: 0,
    reused: 0,
    bytesRead: 0,
    durationMs: clock() - startedAt,
    partial: false,
    budgetMs,
    frozenDays: 0,
    locked: false,
  };

  // The lock comes before the reads, not after: two writers (the systemd timer
  // and /usage) that both read then both write would apply the same late-write
  // delta twice. A run that cannot take it still answers, from what is on disk.
  const lockPath = `${cachePath}.lock`;
  const lock = acquireHistoryLock({ lockPath, now: clock() });
  if (!lock.acquired) {
    // Read-only path: `canWrite: false` keeps it from rebuilding or repairing
    // anything the run that does hold the lock is writing right now.
    const history = loadTotals({ historyDir, warnings, canWrite: false });
    const cached = readCacheFile(cachePath);
    // Nothing here may write: not the history, not the cache, and not a repair
    // of a corrupt month file (review findings N8, N10).
    warnings.push(
      lock.reason
        ? `local token stats: could not take the history lock (${lock.reason}); showing the numbers already on disk and writing nothing`
        : "local token stats: another piquota run is updating the token history; showing the numbers already on disk",
    );
    return {
      byFamily: buildLocalStats({
        totals: history.totals,
        openRows: buildOpenRows(cached.files),
        windowDays: loadWindowDays({
          historyDir,
          dates: recentLocalDates(now, RECENT_DAYS),
          warnings,
          canWrite: false,
        }),
        now,
      }),
      warnings,
      scan: { ...emptyScan, locked: true },
    };
  }

  try {
    // A missing history or a missing cache means every day still on disk has to
    // be rebuildable, so both force a rescan. Frozen days are skipped in that
    // case: they were already counted and a rescan must never add them again.
    const history = loadTotals({ historyDir, warnings, canWrite: true });
    const cached = readCacheFile(cachePath);
    // A rollup that lost its numbers while the cache remembers having seen
    // frozen days is a lost history: rebuild whatever the session files still
    // hold instead of leaving the all-time totals empty.
    const lostHistory =
      history.totals.families.size === 0 &&
      history.totals.lastFrozenDay === "" &&
      typeof cached.historyWatermark === "string" &&
      cached.historyWatermark !== "";
    // Damaged or unreadable month files affect only their daily detail. They
    // never trigger a session rescan: frozen days are not reconstructed from
    // surviving session files.
    const windowDates = recentLocalDates(now, RECENT_DAYS);
    const rescanAll = !cached.hit || history.rescanAll || lostHistory;
    const lastFrozenDay = history.totals.lastFrozenDay;

    const overBudget = () => clock() - startedAt > budgetMs;
    const listedSet = new Set(listen);

    // Fingerprint -> the live path already counted under it. Built from the
    // cache (so a copy made after the original was scanned is still caught) and
    // only for files that still exist: restoring a backup *after* deleting the
    // original must count, not be discarded as a duplicate of a ghost.
    /** @type {Map<string, string>} */
    const counted = new Map();
    for (const path of listen) {
      const entry = cached.files[path];
      if (entry?.fingerprint) counted.set(entry.fingerprint, path);
    }

    /**
     * The surviving file a copy chain bottoms out in.
     *
     * A copy can itself be copied (A -> B -> C), and an older cache may hold a
     * chain. Following `dedupedBy` to its root means deleting a middle copy
     * cannot make the tail look orphaned while the root is still counted
     * (review finding N11).
     *
     * @param {string} path
     * @returns {string | null} A path outside the chain that still exists.
     */
    const rootOriginal = (path) => {
      const seen = new Set([path]);
      let current = cached.files[path]?.dedupedBy;
      while (current) {
        if (seen.has(current)) return null;
        seen.add(current);
        const next = cached.files[current]?.dedupedBy;
        if (!next) return current;
        current = next;
      }
      return null;
    };

    /** @type {Record<string, SessionFileEntry>} */
    const next = {};
    const pendingLate = cached.pendingLate;
    let changed = !cached.hit;
    let scanned = 0;
    let reused = 0;
    let bytesRead = 0;
    let partial = overBudget();

    // The lock is refreshed as the scan walks the store: a cold scan of 1.5 GB
    // takes seconds, but a slower machine or a bigger store could exceed the
    // stale timeout, and another run would then take the lock over while this
    // one kept writing. `lostLock` makes that impossible.
    let lostLock = false;
    let filesSinceRefresh = 0;
    const keepLock = () => {
      filesSinceRefresh += 1;
      if (filesSinceRefresh < 8) return true;
      filesSinceRefresh = 0;
      if (refreshHistoryLock(lock)) return true;
      lostLock = true;
      return false;
    };

    for (const path of listen) {
      if (!keepLock()) break;
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
      // A file that was skipped as a copy of another path has no rows of its
      // own: if the original is gone, this file is now the only holder of those
      // open days and must be read again (review finding N4).
      const cachedEntry = cached.files[path];
      const orphanedCopy = cachedEntry?.dedupedBy !== undefined && !listedSet.has(rootOriginal(path) ?? cachedEntry.dedupedBy);
      const previous = orphanedCopy ? undefined : cachedEntry;
      if (
        previous &&
        !rescanAll &&
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

      // Reading from zero is the rescan case, and every one of these reasons
      // means "count the open days again, never the frozen ones":
      //   - the cache is gone or unreadable (rescanAll);
      //   - the file is a different inode or now shorter than what was read
      //     (replaced, truncated);
      //   - the cache has never seen this path. A copy, a move or a restored
      //     backup looks exactly like a brand-new session, and its old-dated
      //     messages were already frozen under the path it came from;
      //   - the size is unchanged but the mtime moved: an in-place rewrite of
      //     the same length, which reading from the old offset would miss.
      const seen = previous !== undefined;
      const replaced = seen && (previous.ino !== (stats.ino ?? 0) || stats.size < previous.offset);
      const rewritten = seen && previous.size === stats.size && previous.mtimeMs !== stats.mtimeMs;
      const rescan = rescanAll || !seen || replaced || rewritten;

      // A byte-identical copy of a file that is already counted contributes
      // nothing: its messages sit in the original's rows. The entry is still
      // recorded at the copy's end so anything appended to it later is counted.
      const fingerprint = rescan ? fingerprintFile(path, stats.size) : (previous?.fingerprint ?? null);
      // Its own fingerprint in the map is not a copy: a rescan of the same file
      // (a lost history, a rewritten file) must fold its days again.
      const twin = rescan && fingerprint ? counted.get(fingerprint) : undefined;
      const candidate = twin === path ? undefined : twin;
      // The fingerprint samples the head and the tail, which is cheap but can
      // collide: two sessions of the same size that differ only in the middle
      // look identical (review finding N1). Only a candidate that already
      // matched the sample is compared in full, so the expensive hash runs on
      // the rare duplicate and never on a normal run.
      const duplicateOf = candidate !== undefined && sameContent(candidate, path, stats.size) ? candidate : undefined;
      if (rescan && fingerprint && candidate === undefined) counted.set(fingerprint, path);
      if (duplicateOf !== undefined) {
        // Point at the root of the chain, not at whatever file happened to
        // match: a copy of a copy must survive the middle link being deleted.
        const root = rootOriginal(duplicateOf) ?? duplicateOf;
        next[path] = {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ino: stats.ino ?? 0,
          offset: stats.size,
          complete: true,
          fingerprint,
          dedupedBy: root,
          days: {},
        };
        changed = true;
        reused += 1;
        continue;
      }

      const days = rescan ? emptyDays() : decodeDays(previous.days);
      const startOffset = rescan ? 0 : previous.offset;
      let offset;
      let complete;
      try {
        const result = await scanFile({
          path,
          startOffset,
          days,
          now,
          shouldStop: overBudget,
          onUsage: (usage) => {
            if (lastFrozenDay && usage.day <= lastFrozenDay) {
              // Frozen days are never reconstructed on a rescan. Incremental
              // late writes stay in the cache until their month accepts them.
              if (rescan) return;
              addUsage(pendingLate, usage);
              return;
            }
            addUsage(days, usage);
          },
        });
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
        ...(fingerprint ? { fingerprint } : {}),
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
    // lose theirs on this run.
    for (const path of listen) {
      if (!next[path] && cached.files[path]) next[path] = cached.files[path];
    }
    for (const path of Object.keys(cached.files)) {
      if (!listedSet.has(path)) changed = true;
    }

    // Ownership is re-checked here, not only every eight files: a scan of a
    // handful of small files reaches this point without a refresh point, and a
    // run that lost the lock must not write (review finding N8).
    if (!lostLock && !refreshHistoryLock(lock)) lostLock = true;

    // A run that lost the lock must not write anything: another run now owns
    // the history, and a second write is exactly the double count the lock
    // exists to prevent.
    if (lostLock) {
      warnings.push(
        "local token stats: another piquota run took the history lock over during this scan; the numbers below are read-only",
      );
      const windowDays = loadWindowDays({
        historyDir,
        dates: recentLocalDates(now, RECENT_DAYS),
        warnings,
        canWrite: false,
      });
      return {
        byFamily: buildLocalStats({ totals: history.totals, openRows: buildOpenRows(next), windowDays, now }),
        warnings,
        scan: {
          files: listen.length,
          scanned,
          reused,
          bytesRead,
          durationMs: clock() - startedAt,
          partial: true,
          budgetMs,
          frozenDays: 0,
          locked: true,
        },
      };
    }

    const openRows = buildOpenRows(next);
    const pendingBeforeApply = pendingLate.size;
    const applied = applyDurable({
      historyDir,
      totals: history.totals,
      openRows,
      lateRows: buildLateRows(pendingLate),
      today,
      partial,
      writable: history.writable,
      ensure: !history.exists,
      warnings,
    });
    for (const day of pendingLate.keys()) {
      if (!applied.pendingLateDays.has(day)) pendingLate.delete(day);
    }
    if (pendingLate.size !== pendingBeforeApply) changed = true;

    // A day that is in the rollup (frozen now, or already frozen before a crash)
    // must leave the disposable cache; otherwise a rescan would see it twice.
    if (applied.droppedDays.size > 0) {
      for (const entry of Object.values(next)) {
        for (const day of applied.droppedDays) {
          if (entry.days && day in entry.days) delete entry.days[day];
        }
      }
      for (const day of applied.droppedDays) delete openRows[day];
      changed = true;
    }

    if (changed) {
      const written = refreshHistoryLock(lock)
        ? writeCacheFile(cachePath, next, history.totals.lastFrozenDay, encodeDays(pendingLate))
        : { ok: true };
      if (!written.ok) {
        warnings.push(`local token stats: could not write the scan cache at ${cachePath}: ${written.error}`);
      }
    }

    const windowDays = loadWindowDays({ historyDir, dates: recentLocalDates(now, RECENT_DAYS), warnings });

    return {
      byFamily: buildLocalStats({ totals: history.totals, openRows, windowDays, now }),
      warnings,
      scan: {
        files: listen.length,
        scanned,
        reused,
        bytesRead,
        durationMs: clock() - startedAt,
        partial,
        budgetMs,
        frozenDays: applied.frozenDays.length,
        locked: false,
      },
    };
  } finally {
    releaseHistoryLock(lock);
  }
}
