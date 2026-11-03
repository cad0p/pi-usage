/**
 * Local response cache.
 *
 * Holds only the already-normalized report (percentages, windows, labels): no
 * access token, refresh token, API key, cookie or account e-mail beyond the
 * display identity the renderers already print.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_TTL_MS = 60_000;

/**
 * Merge a partial report into an existing cached report so partial family queries
 * do not clobber other cached providers.
 *
 * @param {import("./engine.js").PiQuotaReport | null | undefined} existingReport
 * @param {import("./engine.js").PiQuotaReport} newReport
 * @returns {import("./engine.js").PiQuotaReport}
 */
export function mergeReportIntoCache(existingReport, newReport) {
  if (!existingReport || !existingReport.byFamily) return newReport;
  const mergedByFamily = { ...existingReport.byFamily, ...newReport.byFamily };
  const existingFamilies = Object.keys(existingReport.byFamily);
  const newFamilies = Object.keys(newReport.byFamily || {});
  const allFamilies = Array.from(new Set([...existingFamilies, ...newFamilies]));
  const providers = allFamilies.flatMap((family) => mergedByFamily[family] || []);

  const keptExistingWarnings = (existingReport.warnings || []).filter((w) => {
    const family = String(w).split(":")[0];
    return !newFamilies.includes(family);
  });
  const seenPatterns = new Set();
  const warnings = [];
  for (const w of [...(newReport.warnings || []), ...keptExistingWarnings]) {
    const pattern = w.replace(/\d+m ago/, "Xm ago").replace(/\d+s old/, "Xs old").replace(/\d+s\b/, "Xs");
    if (!seenPatterns.has(pattern)) {
      seenPatterns.add(pattern);
      warnings.push(w);
    }
  }

  return {
    ...existingReport,
    ...newReport,
    providers,
    byFamily: mergedByFamily,
    warnings,
  };
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {string}
 */
export function resolveCachePath(options = {}) {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  const cacheHome = options.home ? join(options.home, ".cache") : (env.XDG_CACHE_HOME || join(homedir(), ".cache"));
  return join(cacheHome, "pi-quota", "usage.json");
}

/**
 * Read the cache envelope, or null when there is not one this version understands.
 *
 * @param {string} path
 * @returns {Record<string, any> | null}
 */
function readPayload(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? /** @type {Record<string, any>} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * The fetch time of every family a cached report carries.
 *
 * The report is written family by family — the Pi extension repaints and saves
 * as each one lands — so `savedAt` says when the *last* family was written and
 * nothing about the others. Judging the whole file by it served Claude's
 * five-minute-old numbers to a reader a minute later, only because Codex had
 * just been saved. Each family therefore keeps its own clock. A cache written
 * before that field existed carries only `savedAt`, and every family falls
 * back to it.
 *
 * @param {Record<string, any>} parsed
 * @param {string[]} families
 * @returns {Record<string, number>}
 */
function payloadClocks(parsed, families) {
  const savedAt = typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt) ? parsed.savedAt : null;
  /** @type {Record<string, number>} */
  const clocks = {};
  const raw = parsed.fetchedAt;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [family, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value)) clocks[family] = value;
    }
  }
  for (const family of families) {
    if (typeof clocks[family] === "number") continue;
    if (savedAt !== null) clocks[family] = savedAt;
  }
  return clocks;
}

/**
 * @param {{
 *   path?: string,
 *   ttlMs?: number,
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   key?: string,       Settings fingerprint; a cached report saved under another key is a miss.
 * }} [options]
 * @returns {{
 *   report: import("./engine.js").PiQuotaReport,
 *   ageMs: number,
 *   fetchedAt: Record<string, number>,
 *   path: string,
 * } | null}
 */
export function readCache(options = {}) {
  const path = options.path ?? resolveCachePath(options);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now();

  const parsed = readPayload(path);
  if (!parsed) return null;
  const report = /** @type {{ report?: import("./engine.js").PiQuotaReport }} */ (parsed).report;
  if (!report || !Array.isArray(report.providers)) return null;

  const savedAt = typeof /** @type {{ savedAt?: unknown }} */ (parsed).savedAt === "number"
    ? /** @type {number} */ (/** @type {{ savedAt?: number }} */ (parsed).savedAt)
    : null;
  if (savedAt === null) return null;
  const families = Array.from(new Set(report.providers.map((provider) => provider.family)));
  const fetchedAt = payloadClocks(parsed, families);
  // The oldest family decides the hit: a report is only as fresh as its stalest
  // part, which is what the single-`savedAt` rule meant before per-family clocks.
  const ageMs = families.length > 0
    ? Math.max(...families.map((family) => now - (fetchedAt[family] ?? savedAt)))
    : now - savedAt;
  if (ageMs > ttlMs) return null;
  // A report collected under other settings (e.g. another Claude source) answers a
  // different question, so it is a miss rather than a stale hit.
  if (options.key !== undefined && /** @type {{ key?: unknown }} */ (parsed).key !== options.key) return null;

  for (const provider of report.providers) {
    for (const win of provider.windows ?? []) {
      if (win.resetsAt) {
        const parsedMs = Date.parse(win.resetsAt);
        if (!Number.isNaN(parsedMs)) {
          win.resetsInSec = Math.max(0, Math.round((parsedMs - now) / 1000));
        }
      }
    }
  }

  return { report, ageMs, fetchedAt, path };
}

/**
 * @param {import("./engine.js").PiQuotaReport} report
 * @param {{
 *   path?: string,
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   merge?: boolean,
 *   key?: string,
 *   fetchedAtMs?: Record<string, number>,  Each family's own fetch time; absent ones are this write's.
 * }} [options]
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function writeCache(report, options = {}) {
  const path = options.path ?? resolveCachePath(options);
  const now = options.now ?? Date.now();
  const existing = readCache({ ...options, path, ttlMs: Number.POSITIVE_INFINITY });
  let finalReport = report;
  if (options.merge && existing?.report) {
    finalReport = mergeReportIntoCache(existing.report, report);
  }
  const written = new Set((report.providers ?? []).map((provider) => provider.family));
  const provided = options.fetchedAtMs ?? {};
  /** @type {Record<string, number>} */
  const fetchedAt = {};
  for (const family of new Set((finalReport.providers ?? []).map((provider) => provider.family))) {
    // A family this write produced was fetched now unless the caller knows a
    // better time; a family merged in from the cache keeps the clock it had.
    const own = provided[family];
    const at = typeof own === "number" && Number.isFinite(own) ? own : (written.has(family) ? now : existing?.fetchedAt?.[family]);
    fetchedAt[family] = typeof at === "number" && Number.isFinite(at) ? at : now;
  }
  const envelope = { savedAt: now, ...(options.key === undefined ? {} : { key: options.key }), fetchedAt, report: finalReport };
  const payload = JSON.stringify(envelope, null, 2);

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, payload, { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Best-effort in environments where chmod is not supported.
    }
    renameSync(temporary, path);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, path, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }
}

/**
 * @param {{ path?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ removed: boolean, path: string }}
 */
export function clearCache(options = {}) {
  const path = options.path ?? resolveCachePath(options);
  try {
    rmSync(path, { force: true });
    return { removed: true, path };
  } catch {
    return { removed: false, path };
  }
}

/**
 * @param {{ path?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ exists: boolean, path: string, sizeBytes: number | null }}
 */
export function describeCache(options = {}) {
  const path = options.path ?? resolveCachePath(options);
  try {
    const stats = statSync(path);
    return { exists: true, path, sizeBytes: stats.size };
  } catch {
    return { exists: false, path, sizeBytes: null };
  }
}

/**
 * Read-through helper: return a fresh cached report or refresh it.
 *
 * @param {{
 *   ttlMs?: number,
 *   now?: number,
 *   force?: boolean,
 *   path?: string,
 *   families?: string[],
 *   merge?: boolean,
 *   key?: string,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 * }} options
 * @param {() => Promise<import("./engine.js").PiQuotaReport>} loader
 * @returns {Promise<{ report: import("./engine.js").PiQuotaReport, cached: boolean, ageMs: number }>}
 */
export async function withCache(options, loader) {
  const requested = options.families;
  if (!options.force) {
    // Freshness is decided per family below, so the read must not apply one
    // TTL to the whole file first.
    const hit = readCache({ ...options, ttlMs: Number.POSITIVE_INFINITY });
    if (hit) {
      const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
      const now = options.now ?? Date.now();
      const present = new Set(hit.report.providers.map((provider) => provider.family));
      const wanted = requested ?? Array.from(present);
      const fresh = wanted.every((family) => present.has(family) && now - (hit.fetchedAt[family] ?? 0) <= ttlMs);
      if (fresh) {
        const filteredReport = requested
          ? {
              ...hit.report,
              providers: hit.report.providers.filter((p) => requested.includes(p.family)),
              byFamily: Object.fromEntries(
                Object.entries(hit.report.byFamily).filter(([fam]) => requested.includes(fam)),
              ),
            }
          : hit.report;
        const ageMs = wanted.length > 0
          ? Math.max(...wanted.map((family) => now - (hit.fetchedAt[family] ?? now)))
          : hit.ageMs;
        return { report: filteredReport, cached: true, ageMs };
      }
    }
  }
  const report = await loader();
  const isPartial = Array.isArray(requested) && requested.length > 0;
  writeCache(report, { ...options, merge: isPartial || options.merge });
  return { report, cached: false, ageMs: 0 };
}
