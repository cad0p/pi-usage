#!/usr/bin/env node
/**
 * piquota — independent, read-only quota for the credentials Pi already owns.
 *
 *   piquota                      panel for Claude, Codex, Antigravity, OpenCode Go, Mistral, Devin
 *   piquota --json               normalized report (used by rp-host / tools)
 *   piquota --compact | --status | --explain
 *   piquota auth opencode        open the OpenCode login and capture the session
 *   piquota auth status          show which credential sources are reachable
 *   piquota omarchy              publish pi-*.json records for Omarchy's Agents bar panel
 *   piquota gentle-pi <status|apply|revert>
 *                                the rail slot gentle-pi needs to paint the quota card
 */

import { readFileSync } from "node:fs";

import { clearCache, withCache } from "../src/cache.js";
import { parseArgs } from "../src/cli/args.js";
import { runAuthCommand } from "../src/cli/commands/auth.js";
import { runGentlePiCommand } from "../src/cli/commands/gentle-pi.js";
import { runOmarchyCommand } from "../src/cli/commands/omarchy.js";
import { runStatsCommand } from "../src/cli/commands/stats.js";
import { explainLines, resolveFamilies } from "../src/cli/explain.js";
import { err, out } from "../src/cli/output.js";
import { collectQuota, enabledFamilies, normalizeClaudeSourceMode } from "../src/engine.js";
import { redact } from "../src/http.js";
import { mergeLastGood } from "../src/sticky.js";
import { renderBoxWidget, renderCompact, renderPanel, renderStatusLine } from "../src/render/panel.js";
import { ansiPalette } from "../src/render/theme.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

/**
 * The cache answers for the settings it was collected under: a Claude source
 * switch must refetch instead of serving the other source's result.
 */
const CACHE_KEY = `claude-source:${normalizeClaudeSourceMode(process.env.PI_QUOTA_CLAUDE_SOURCE)}`;

/**
 * Local token statistics from Pi's session files are on for the CLI: the Omarchy
 * records and /usage both show them. `PI_QUOTA_LOCAL_STATS=0` turns the scan
 * off (e.g. on a machine where the session store is huge and network quota is
 * all that matters), and the budget keeps a first full scan from delaying a
 * report past the 30 s the /usage extension allows.
 */
const LOCAL_STATS_BUDGET_MS = Number(process.env.PI_QUOTA_LOCAL_STATS_BUDGET_MS);
const LOCAL_STATS = process.env.PI_QUOTA_LOCAL_STATS === "0"
  ? false
  : LOCAL_STATS_BUDGET_MS > 0
    ? { budgetMs: LOCAL_STATS_BUDGET_MS }
    : {};

const HELP = `piquota ${VERSION} — read-only quota from Pi's provider credentials

Usage:
  piquota [families...] [flags]
  piquota auth <opencode|status> [flags]
  piquota gentle-pi <status|apply|revert>
  piquota omarchy
  piquota stats [--json] [--month YYYY-MM] [--rebuild-totals]

Quota:
  --json             Emit the normalized report as JSON (for rp-host and automations)
  --compact, -c      One line per provider
  --status           Single line with rings
  --box              Compact right-aligned 5-row box widget
  --no-color         Disable ANSI colors
  --no-cache         Skip the local cache
  --force            Ignore a still-fresh cache entry
  --ttl <seconds>    Cache TTL (default 60)
  --timeout <ms>     Per-request timeout (default 15000)
  --no-refresh       Never refresh Antigravity's token in memory
  --explain          Show which stores/fields are read (names only)
  --clear-cache      Delete the local cache and exit
  --rebuild-totals   With \`stats\`: rebuild the token-history totals from its month files
  --month YYYY-MM    With \`stats\`: read one month (default: the current local month)
  --version          Print the version and exit

Auth (OpenCode Go session, the only credential Pi does not store):
  piquota auth opencode            open the login in Firefox and capture the cookie
  piquota auth opencode --paste    read the cookie from stdin instead
  piquota auth opencode --no-browser
                                   print the URL without launching a browser
  piquota auth opencode --wait <s> how long to wait for the login (default 180)
  piquota auth status              report every credential source

Stats:
  piquota stats                    summarise the durable token history
                                   (dir: \${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-usage)
  piquota stats --json [--month]   read-only JSON: months (the live month always),
                                   one month's days per family/slot/model, all-time
                                   totals, notes
  piquota stats --rebuild-totals   recompute totals.json from the frozen month files

Omarchy:
  piquota omarchy                  write pi-<family>.json records for Omarchy's Agents bar panel
                                   (dir: $PI_QUOTA_OMARCHY_DIR or $XDG_STATE_HOME/omarchy/agents/usage)
                                   run it on a timer: ./install.sh --omarchy-timer

Environment:
  PI_QUOTA_LOCAL_STATS=0          skip the token scan of Pi's session files
  PI_QUOTA_LOCAL_STATS_BUDGET_MS  wall-clock budget for that scan (default 12000)
  PI_QUOTA_ACCOUNT_CONCURRENCY    accounts of one provider queried at once (1-32, default 8)

Guarantees:
  * ~/.pi/agent/auth.json is opened read-only. Never written, synced or refreshed.
  * Pi's session files are opened read-only too; the token scan keeps only
    aggregate counts per day and model, never prompt text or session paths.
  * Antigravity's access token may be refreshed in memory; it is never persisted.
  * Browser cookie databases are copied and opened read-only; values are never logged.
  * Only percentages, window labels, reset times, plan names and aggregate token
    counts leave this machine.
  * \`omarchy\` (opt-in) writes only pi-*.json records, atomically, into Omarchy's usage dir;
    records hold plan names, percentages, window labels, reset times and aggregate
    token counts, never prompt text or accounts.
  * \`gentle-pi\` is the one file this tool edits outside its own state: it appends
    piQuota's part to gentle-pi's rail allowlist so the card can be painted there.
    The edit is one array literal, it is reversible with \`piquota gentle-pi revert\`,
    and the previous revision is kept next to the file as a \`.pi-quota-backup\`.
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const bare = args.positionals;
  const command = bare[0] ?? null;
  const agentMode = "native";
  const refresh = !argv.includes("--no-refresh");

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    out(`piquota ${VERSION}`);
    return 0;
  }
  if (args.clearCache) {
    const result = clearCache({});
    out(result.removed ? `cache cleared: ${result.path}` : `no cache at ${result.path}`);
    return 0;
  }

  if (args.unknown.length > 0) {
    err(`unknown flag: ${args.unknown.join(" ")}\n`);
    process.stdout.write(HELP);
    return 2;
  }

  if (command === "auth") {
    const sub = bare[1] ?? "status";
    return runAuthCommand(sub, argv);
  }

  if (command === "gentle-pi") {
    const sub = bare[1] ?? "status";
    return runGentlePiCommand(sub);
  }

  if (args.rebuildTotals && command !== "stats") {
    // The flag repairs one thing (the all-time rollup) and reads nothing else,
    // so running it beside `piquota` or `piquota omarchy` would silently skip
    // the command the user asked for.
    err("--rebuild-totals only works with `piquota stats`\n");
    process.stdout.write(HELP);
    return 2;
  }

  if (args.month && command !== "stats") {
    err("--month only works with \`piquota stats\`\n");
    process.stdout.write(HELP);
    return 2;
  }

  if (command === "stats") {
    return runStatsCommand({ rebuild: args.rebuildTotals, json: args.json, month: args.month, env: process.env });
  }

  if (command === "omarchy") {
    const load = async ({ onFamily } = {}) => {
      const everyFamily = enabledFamilies({ env: process.env });
      const publishFamily = onFamily
        ? async (family, fragment) => onFamily(family, mergeLastGood(fragment, {}).report)
        : undefined;
      const loadFresh = () =>
        collectQuota({
          families: everyFamily,
          timeoutMs: args.timeoutMs,
          refresh,
          force: args.force,
          localStats: LOCAL_STATS,
          onFamily: publishFamily,
        });
      const fresh = args.noCache
        ? await loadFresh()
        : (await withCache({ ttlMs: args.ttlMs, force: args.force, families: everyFamily, key: CACHE_KEY }, loadFresh)).report;
      return mergeLastGood(fresh, {}).report;
    };
    return runOmarchyCommand({ load });
  }

  const { families, unknown, explicit } = resolveFamilies(
    command === "quota" ? bare.slice(1) : bare.filter((value) => value !== "quota"),
  );

  if (unknown.length > 0) {
    err(`unknown argument: ${unknown.join(" ")}\n`);
    process.stdout.write(HELP);
    return 2;
  }

  const selected = enabledFamilies({
    env: process.env,
    requested: families.length > 0 ? families : undefined,
    explicit,
  });
  const load = () =>
    collectQuota({ families: selected, explicit, timeoutMs: args.timeoutMs, refresh, force: args.force, localStats: LOCAL_STATS });

  let report;
  let cached = false;
  let ageMs = 0;
  if (args.noCache) {
    report = await load();
  } else {
    const result = await withCache({ ttlMs: args.ttlMs, force: args.force, families: selected, key: CACHE_KEY }, load);
    report = result.report;
    cached = result.cached;
    ageMs = result.ageMs;
  }

  const { report: reportWithHistory, restored } = mergeLastGood(report, {});
  report = reportWithHistory;
  if (restored.length > 0 && !args.json && !args.compact && !args.status) {
    process.stderr.write(`note: showing last known values for ${restored.join(", ")}\n`);
  }

  const paint = ansiPalette({ color: args.color });

  if (args.json) {
    out(JSON.stringify({ ...report, cache: { used: cached, ageMs } }, null, 2));
    return report.providers.some((provider) => provider.ok) ? 0 : 1;
  }
  if (args.status) {
    out(renderStatusLine(report.providers, paint));
    return 0;
  }
  if (args.box) {
    for (const line of renderBoxWidget(report.providers, paint)) out(line);
  } else if (args.compact) {
    for (const line of renderCompact(report.providers, paint)) out(line);
  } else {
    for (const line of renderPanel(report.providers, paint, {
      generatedAt: report.generatedAt,
      warnings: report.warnings,
    })) {
      out(line);
    }
  }
  if (args.explain) {
    for (const line of explainLines(selected)) out(line);
  }

  return report.providers.some((provider) => provider.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    err(`piquota failed: ${redact(/** @type {{ message?: string }} */ (error)?.message ?? error)}`);
    process.exit(1);
  },
);
