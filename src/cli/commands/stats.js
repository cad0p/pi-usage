/**
 * `piquota stats`: read or rebuild the durable token history.
 *
 * The history is the one place tokens accumulate across runs; this command is
 * the read-only view of it and the recovery path for a lost `totals.json`.
 */

import { loadTotals, rebuildTotalsFromMonths, resolveHistoryDir } from "../../local/history.js";
import { redact } from "../../http.js";
import { err, out } from "../output.js";

/**
 * @param {{
 *   rebuild?: boolean,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   historyDir?: string,
 * }} [options]
 * @returns {number} Exit code.
 */
export function runStatsCommand(options = {}) {
  const env = options.env ?? process.env;
  const historyDir = options.historyDir ?? resolveHistoryDir({ env, home: options.home });
  /** @type {string[]} */
  const warnings = [];

  if (options.rebuild) {
    const result = rebuildTotalsFromMonths({ historyDir, warnings });
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
