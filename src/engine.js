/**
 * Quota collection engine.
 *
 * Loads Pi credentials (read-only), asks each provider for its windows and
 * returns one normalized report. Providers never throw: a failure becomes a
 * degraded result with an actionable message.
 */

import { checkFreshness, LABEL_BY_FAMILY, loadPiCredentials, normalizeCredential, resolveAuthPaths } from "./auth/pi-auth.js";
import { loadClaudeCodeCredential } from "./auth/claude-code-auth.js";
import { redact } from "./http.js";
import { collectLocalStats } from "./local/pi-sessions.js";
import { degradedResult, displayIdentity, selectPrimaryWindow } from "./model.js";
import { backoffState, clearBackoff, isAuthFailure, isThrottled, recordBackoff, retryAfterFromError } from "./providers/backoff.js";
import { fetchQuota as fetchClaude } from "./providers/claude.js";
import { fetchQuota as fetchCodex } from "./providers/codex.js";
import { fetchQuota as fetchAntigravity } from "./providers/antigravity.js";
import { fetchQuota as fetchOpenCodeGo } from "./providers/opencode-go.js";
import { fetchQuota as fetchMistral } from "./providers/mistral.js";
import { fetchQuota as fetchGithubActions } from "./providers/github-actions.js";

/** Canonical family order used by every surface. */
export const FAMILIES = ["claude", "codex", "antigravity", "opencode-go", "mistral", "github-actions"];

/**
 * Return the ordered families enabled for a run.
 *
 * GitHub Actions joins a default family list only when the env flag is truthy.
 * A positional family selection sets `explicit` to record user consent directly,
 * independent of whether the requested array has been copied or transformed.
 *
 * @param {{ env?: Record<string, string | undefined>, requested?: string[], explicit?: boolean }} [input]
 * @returns {string[]}
 */
export function enabledFamilies(input = {}) {
  const env = input.env ?? process.env;
  const requested = input.requested;
  const families = requested ?? FAMILIES;
  const explicit = input.explicit ?? false;
  const includeGithubActions = isTruthyFlag(env.PI_QUOTA_GITHUB_ACTIONS) || explicit;
  return families.filter((family) => family !== "github-actions" || includeGithubActions);
}
const GH_CLI_CREDENTIAL = {
  family: "github-actions",
  label: "GitHub Actions",
  source: "gh CLI",
  identity: "GitHub CLI",
  expiresAtMs: null,
};

/** @param {string | undefined} value */
function isTruthyFlag(value) {
  return typeof value === "string" && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Claude has two possible sources, and a user may have either or both.
 *
 * `auto` prefers the Claude Code CLI, because the plugin that drives it is what a
 * user reaches for when Pi's own `anthropic` token cannot serve requests. The
 * choice is a preference, never a fallback: only the selected source is tried, so
 * a broken preferred source is reported instead of silently masked by the other.
 */
export const CLAUDE_SOURCE_MODES = ["auto", "claude-code", "pi"];

/**
 * @param {unknown} value
 * @returns {"auto" | "claude-code" | "pi"}
 */
export function normalizeClaudeSourceMode(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "claude-code" || text === "claude" || text === "cli") return "claude-code";
  if (text === "pi" || text === "anthropic" || text === "oauth") return "pi";
  return "auto";
}

/**
 * Pick the Claude credential set for this run.
 *
 * @param {{
 *   credentials: import("./auth/pi-auth.js").PiCredential[],
 *   env: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   usersRoot?: string,
 *   claudeCodePaths?: string[] | null,
 * }} input
 * @returns {{ credentials: import("./auth/pi-auth.js").PiCredential[], mode: string, unavailable: string | null, claudeCodePaths: string[] }}
 */
export function resolveClaudeCredentials(input) {
  const mode = normalizeClaudeSourceMode(input.env.PI_QUOTA_CLAUDE_SOURCE);
  const fromPi = input.credentials.filter((credential) => credential.family === "claude");
  const claudeCodePaths = input.claudeCodePaths === undefined ? undefined : input.claudeCodePaths;

  if (mode === "pi") return { credentials: fromPi, mode, unavailable: null, claudeCodePaths: claudeCodePaths ?? [], recoveredLock: null };

  const claudeCode = loadClaudeCodeCredential({
    env: input.env,
    home: input.home,
    platform: input.platform,
    usersRoot: input.usersRoot,
    paths: claudeCodePaths ?? undefined,
    now: input.now,
  });

  // `auto` prefers the Claude Code CLI only while its token is still usable. A
  // leftover store from an uninstalled CLI never refreshes again, so once it has
  // expired Pi's own login is the better source whenever Pi still has a fresh one.
  if (claudeCode.ok && mode === "auto" && !checkFreshness(claudeCode.credential, input.now ?? Date.now()).fresh) {
    const freshPi = fromPi.filter((credential) => checkFreshness(credential, input.now ?? Date.now()).fresh);
    if (freshPi.length > 0) {
      const expiredMin = Math.abs(checkFreshness(claudeCode.credential, input.now ?? Date.now()).expiresInMin ?? 0);
      return {
        credentials: freshPi,
        mode: "pi",
        unavailable: null,
        // Said out loud so the switch is never silent: the report names the source
        // it used and why the preferred one was passed over.
        notice: `claude: the Claude Code token expired ${expiredMin}m ago; using Pi's anthropic login instead`,
        claudeCodePaths: claudeCode.paths,
        recoveredLock: claudeCode.recoveredLock ?? null,
      };
    }
  }

  if (claudeCode.ok) {
    // Pay-as-you-go API keys (`anthropic-1-api`) are accounts of their own,
    // not a second source for the subscription, so the source choice keeps them.
    const apiKeys = fromPi.filter((credential) => credential.kind === "api_key");
    return {
      credentials: [claudeCode.credential, ...apiKeys],
      mode: "claude-code",
      unavailable: null,
      claudeCodePaths: claudeCode.paths,
      recoveredLock: claudeCode.recoveredLock ?? null,
    };
  }
  if (mode === "claude-code") {
    return {
      credentials: [],
      mode,
      unavailable: claudeCode.error,
      claudeCodePaths: claudeCode.paths,
      recoveredLock: claudeCode.recoveredLock ?? null,
    };
  }
  return {
    credentials: fromPi,
    mode: "pi",
    unavailable: null,
    claudeCodePaths: claudeCode.paths,
    recoveredLock: claudeCode.recoveredLock ?? null,
  };
}

/** Default number of accounts of one family queried at the same time. */
export const DEFAULT_ACCOUNT_CONCURRENCY = 8;

/**
 * `PI_QUOTA_ACCOUNT_CONCURRENCY` (1-32) bounds the parallel account requests of
 * one family; 1 restores the sequential behaviour.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function accountConcurrency(env) {
  const value = Number.parseInt(env.PI_QUOTA_ACCOUNT_CONCURRENCY ?? "", 10);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_ACCOUNT_CONCURRENCY;
  return Math.min(32, value);
}

/**
 * Map with at most `limit` calls in flight, results in input order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapBounded(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  // A non-numeric limit would otherwise start no worker and return holes.
  const bounded = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  await Promise.all(Array.from({ length: Math.min(bounded, items.length) }, worker));
  return results;
}

/** @type {Record<string, (credential: any, options?: any) => Promise<import("./model.js").QuotaResult>>} */
const PROVIDERS = {
  claude: fetchClaude,
  codex: fetchCodex,
  antigravity: fetchAntigravity,
  "opencode-go": fetchOpenCodeGo,
  mistral: fetchMistral,
  "github-actions": fetchGithubActions,
};

/**
 * @typedef {Object} PiQuotaReport
 * @property {string} engine
 * @property {number} schemaVersion
 * @property {true} readOnly
 * @property {string} generatedAt
 * @property {string[]} sources               Pi auth stores that were read.
 * @property {string[]} warnings
 * @property {import("./model.js").QuotaResult[]} providers   Flattened, family-ordered.
 * @property {Record<string, import("./model.js").QuotaResult[]>} byFamily
 * @property {Record<string, import("./local/pi-sessions.js").LocalFamilyStats>} localStats
 *           Tokens Pi's own session files recorded, per family. Empty when the
 *           scan is disabled, still warming up or has nothing to report.
 * @property {import("./local/pi-sessions.js").LocalScanMeta | null} localStatsMeta
 *           How the token scan went, including `partial` and `locked`.
 */

/**
 * @param {{
 *   families?: string[],
 *   explicit?: boolean,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   usersRoot?: string,
 *   paths?: string[],
 *   now?: number,
 *   fetchFn?: typeof fetch,
 *   runCommand?: typeof import("./exec.js").runCommand,
 *   timeoutMs?: number,
 *   refresh?: boolean,
 *   force?: boolean,
 *   stores?: import("./browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 *   claudeCodePaths?: string[] | null,
 *   localStats?: boolean | import("./local/pi-sessions.js").LocalStatsOptions,
 *     Local token statistics from Pi's session files. Off unless asked for, so
 *     tests and library callers never read a real home directory; the CLI turns
 *     it on with a time budget. Pass an object to inject session roots or a
 *     cache path, or false to disable it explicitly.
 *   onFamily?: (family: string, report: PiQuotaReport) => void | Promise<void>,
 *     Called once a family has settled, before the other families necessarily
 *     finish. The report fragment contains only that family's results.
 *   authOverrides?: Record<string, { access: string, expiresAtMs?: number | null, accountId?: string | null }>,
 *     Optional in-memory OAuth access tokens supplied by the host runtime. Never
 *     persisted or included in reports.
 * }} [options]
 * @returns {Promise<PiQuotaReport>}
 */
export async function collectQuota(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const families = enabledFamilies({ env, requested: options.families, explicit: options.explicit });

  const loaded = loadPiCredentials({
    env,
    home: options.home,
    platform: options.platform,
    usersRoot: options.usersRoot,
    paths: options.paths,
  });

  // Pi's extension host may have resolved/renewed an OAuth token through Pi's
  // own locked auth path. Apply only to the matching provider in memory; the
  // underlying file reader remains read-only and the token never reaches output.
  for (const [provider, auth] of Object.entries(options.authOverrides ?? {})) {
    if (typeof auth?.access !== "string" || auth.access === "") continue;
    let matched = false;
    for (const credential of loaded.credentials) {
      if (credential.provider !== provider) continue;
      credential.access = auth.access;
      credential.expiresAtMs = auth.expiresAtMs ?? null;
      if (typeof auth.accountId === "string" && auth.accountId !== "") credential.accountId = auth.accountId;
      matched = true;
    }
    // Pi may own auth from a non-default agent directory that the standalone
    // read-only path discovery does not know about. A host-resolved OAuth token
    // is sufficient to create the in-memory provider entry; never persist it.
    if (!matched) {
      const credential = normalizeCredential(
        provider,
        {
          type: "oauth",
          access: auth.access,
          expires: auth.expiresAtMs,
          accountId: auth.accountId,
        },
        "Pi runtime auth",
      );
      if (credential) loaded.credentials.push(credential);
    }
  }

  // Claude is the one family with a second, non-Pi source, so it is resolved
  // before the per-family loop and then treated exactly like any other credential.
  const claude = resolveClaudeCredentials({
    credentials: loaded.credentials,
    env,
    home: options.home,
    platform: options.platform,
    usersRoot: options.usersRoot,
    claudeCodePaths: options.claudeCodePaths,
    now,
  });

  /**
   * @param {string} family
   * @returns {import("./auth/pi-auth.js").PiCredential[]}
   */
  const credentialsFor = (family) => {
    if (family === "claude") return claude.credentials;
    if (family === "github-actions") return [GH_CLI_CREDENTIAL];
    return loaded.credentials.filter((credential) => credential.family === family);
  };

  /** @type {Record<string, import("./model.js").QuotaResult[]>} */
  const byFamily = {};
  /** @type {string[]} */
  const warnings = [...loaded.warnings];
  if (claude.notice) warnings.push(claude.notice);
  if (claude.recoveredLock) {
    warnings.push(
      `claude: removed abandoned OAuth refresh lock (${Math.round((claude.recoveredLock.ageMs ?? 0) / 1000)}s old) at ${claude.recoveredLock.lockPath}`,
    );
  }
  /** @type {Record<string, string[]>} */
  const familyWarnings = {};

  /**
   * Publish a family fragment as soon as its provider work is complete. A
   * callback failure is isolated from provider collection and becomes a warning
   * on the final report.
   *
   * @param {string} family
   * @param {import("./model.js").QuotaResult[]} results
   */
  const emitFamily = async (family, results) => {
    for (const provider of results) {
      provider.primaryWindowId = selectPrimaryWindow(provider.windows ?? [])?.id ?? null;
    }
    byFamily[family] = results;
    familyWarnings[family] ??= [];
    if (!options.onFamily) return;
    const fragment = {
      engine: "pi-quota",
      schemaVersion: 1,
      readOnly: true,
      generatedAt: new Date(now).toISOString(),
      sources: loaded.paths,
      claudeSource: { mode: claude.mode, paths: claude.claudeCodePaths, unavailable: claude.unavailable },
      warnings: [...warnings, ...familyWarnings[family]],
      providers: results,
      byFamily: { [family]: results },
      localStats: {},
      localStatsMeta: null,
    };
    try {
      await options.onFamily(family, fragment);
    } catch (error) {
      familyWarnings[family].push(
        `${family}: family callback failed: ${redact(/** @type {{ message?: string }} */ (error)?.message ?? String(error))}`,
      );
    }
  };

  const hasOpenAi = loaded.rawProviders?.includes("openai") || Boolean(env.OPENAI_API_KEY);

  // The local scan runs beside the network calls: a first full scan of the
  // session store costs seconds, and adding that to the quota round-trip would
  // push the /usage extension closer to its 30 s exec timeout.
  const localStatsOptions = typeof options.localStats === "object" && options.localStats !== null ? options.localStats : {};
  const localStatsTask =
    options.localStats === undefined || options.localStats === false
      ? null
      : collectLocalStats({ env, home: options.home, now, ...localStatsOptions }).catch(
          (error) => /** @type {{ error: unknown }} */ ({ error }),
        );

  await Promise.all(
    families.map(async (family) => {
      const credentials = credentialsFor(family);
      if (credentials.length === 0) {
        // `notConfigured` is stated rather than inferred: the message now names a
        // second source, and every renderer keys off this flag to avoid painting a
        // failure icon for a provider the user simply does not use.
        await emitFamily(family, [
          degradedResult({
            family,
            label: LABEL_BY_FAMILY[family] ?? family,
            error: claude.unavailable && family === "claude" ? claude.unavailable : missingCredentialMessage(family, { hasOpenAi }),
            notConfigured: true,
            source: loaded.paths[0] ?? resolveAuthPaths({ env, home: options.home })[0] ?? "~/.pi/agent/auth.json",
            now,
          }),
        ]);
        return;
      }

      // A family that is currently throttled is skipped entirely, so the
      // caller's sticky layer can republish the previous good snapshot instead
      // of adding more pressure to a rate-limited endpoint.
      //
      // Authentication failures supersede throttling: if any credential for this
      // family is already known to be expired, waiting out a rate limit is useless
      // and misleading. We clear backoff immediately so the auth failure surfaces.
      const hasExpiredToken = credentials.some((credential) => {
        const freshness = checkFreshness(credential, now);
        return !freshness.fresh;
      });
      if (hasExpiredToken || options.force) {
        clearBackoff(family, { env, home: options.home });
      }

      const throttle = backoffState(family, { now, env, home: options.home });
      if (throttle.active && !options.force) {
        await emitFamily(family, [
          degradedResult({
            family,
            label: LABEL_BY_FAMILY[family] ?? family,
            // Keep the identity visible while paused: "unknown" on screen is
            // worse than a stale-but-labelled account.
            account: displayIdentity(credentials[0]),
            error: `backing off after a throttle: next attempt in ${throttle.secondsLeft}s`,
            source: credentials[0].source,
            now,
          }),
        ]);
        return;
      }

      // Accounts of one family are independent requests, so they run in
      // parallel (bounded): with 14 OpenCode Go keys a sequential loop cost
      // ~3.8 s, a parallel one costs about one round trip. Results keep the
      // credential order, and the backoff bookkeeping is replayed in that same
      // order afterwards, so the final backoff state is exactly what the
      // sequential loop produced.
      const fetchQuota = PROVIDERS[family];
      const outcomes = await mapBounded(credentials, accountConcurrency(env), async (credential) => {
        const freshness = checkFreshness(credential, now);
        const warning = freshness.fresh
          ? null
          : `${family}: the ${expiredTokenName(credential)} expired ${Math.abs(freshness.expiresInMin ?? 0)}m ago; ${refreshHint(credential)}`;
        try {
          const result = await fetchQuota(credential, {
            now,
            fetchFn: options.fetchFn,
            runCommand: options.runCommand,
            timeoutMs: options.timeoutMs,
            expiresInMin: freshness.expiresInMin,
            env,
            home: options.home,
            refresh: options.refresh,
            stores: options.stores,
            allowBrowser: options.allowBrowser,
          });
          // The renderers group siblings by family; the record builder needs the
          // slot to label each account without re-parsing its display string.
          result.slot = credential.slot ?? null;
          return { result, warning, crashed: false };
        } catch (error) {
          // A provider must never take the whole report down.
          const crashed = degradedResult({
            family,
            label: credential.label,
            account: credential.email ?? credential.accountId ?? "unknown",
            error: `provider crashed: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
            source: credential.source,
            now,
            expiresInMin: freshness.expiresInMin,
          });
          crashed.slot = credential.slot ?? null;
          return { result: crashed, warning, crashed: true };
        }
      });

      /** @type {import("./model.js").QuotaResult[]} */
      const results = [];
      const familyWarnList = [];
      for (const { result, warning, crashed } of outcomes) {
        // The stored-credential warning is a claim about this run, and a provider
        // that renewed the token in memory for it knows better than the store:
        // "the Pi token expired 271316m ago" next to two healthy Antigravity
        // windows was reading Pi's stale copy, not the token that was used.
        if (warning && result.tokenRenewedInMemory !== true) familyWarnList.push(warning);
        if (!crashed) {
          // Bookkeeping must degrade like the provider call it follows: a
          // failing backoff write is a warning, never a rejected family.
          try {
            if (isThrottled(result.error)) {
              const seconds = recordBackoff(family, {
                retryAfterSec: retryAfterFromError(result.error),
                now,
                env,
                home: options.home,
              }).seconds;
              familyWarnList.push(`${family}: throttled upstream; pausing that family for ${seconds}s`);
            } else if (result.ok || isAuthFailure(result.error)) {
              clearBackoff(family, { env, home: options.home });
            }
          } catch (error) {
            familyWarnList.push(`${family}: could not update the backoff state: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`);
          }
        }
        results.push(result);
      }
      familyWarnings[family] = familyWarnList;
      await emitFamily(family, results);
    }),
  );

  for (const family of families) {
    if (familyWarnings[family]) {
      warnings.push(...familyWarnings[family]);
    }
  }

  const providers = families.flatMap((family) => byFamily[family] ?? []);

  // Stamp the primary window so the terminal, the Pi TUI and the Moshi adapter
  // all agree on which window represents a provider, with no duplicated rules.
  for (const provider of providers) {
    provider.primaryWindowId = selectPrimaryWindow(provider.windows ?? [])?.id ?? null;
  }

  // Local statistics are a bonus, never a reason for a provider to fail: a
  // rejected scan is reported as one warning and the report carries no numbers.
  /** @type {Record<string, import("./local/pi-sessions.js").LocalFamilyStats>} */
  let localStats = {};
  /** @type {PiQuotaReport["localStatsMeta"]} */
  let localStatsMeta = null;
  if (localStatsTask) {
    const local = await localStatsTask;
    if ("error" in local) {
      warnings.push(
        `local token stats: ${redact(/** @type {{ message?: string }} */ (local.error)?.message ?? String(local.error))}`,
      );
    } else {
      localStats = local.byFamily;
      localStatsMeta = local.scan;
      warnings.push(...local.warnings);
    }
  }

  return {
    engine: "pi-quota",
    schemaVersion: 1,
    readOnly: true,
    generatedAt: new Date(now).toISOString(),
    sources: loaded.paths,
    // Named so `piquota --explain` can state which Claude source was chosen and
    // every surface agrees, instead of each one guessing.
    claudeSource: { mode: claude.mode, paths: claude.claudeCodePaths, unavailable: claude.unavailable },
    warnings,
    providers,
    byFamily,
    localStats,
    localStatsMeta,
  };
}

/**
 * @param {string} family
 * @param {{ hasOpenAi?: boolean }} [context]
 * @returns {string}
 */
function missingCredentialMessage(family, context = {}) {
  if (family === "claude") {
    return "no claude credential in the Pi store or from the Claude Code CLI";
  }
  if (family === "github-actions") {
    return "GitHub Actions uses the authenticated gh CLI; no Pi-store credential is required";
  }
  if (family === "codex" && context.hasOpenAi) {
    return "no codex credential in the Pi store (found 'openai' API; run /login openai-codex in Pi for subscription quota)";
  }
  return `no ${family} credential in the Pi store`;
}

/**
 * @param {{ sourceKind?: string }} credential
 * @returns {string}
 */
function expiredTokenName(credential) {
  return credential.sourceKind === "claude-code" ? "Claude Code token" : "Pi token";
}

/**
 * @param {{ sourceKind?: string }} credential
 * @returns {string}
 */
function refreshHint(credential) {
  return credential.sourceKind === "claude-code"
    ? "run `claude` once to refresh it"
    : "use that provider in Pi to refresh it";
}

/**
 * Convenience accessor used by the renderers.
 *
 * @param {PiQuotaReport} report
 * @returns {import("./model.js").QuotaResult | null}
 */
export function firstForFamily(report, family) {
  return report.byFamily[family]?.[0] ?? null;
}

/**
 * Collect a single family using the same normalized engine and callback
 * semantics as collectQuota. This is useful to independent refresh schedulers:
 * an in-flight family does not serialize another family's request.
 *
 * @param {string} family
 * @param {Parameters<typeof collectQuota>[0]} [options]
 * @returns {Promise<PiQuotaReport>}
 */
export function collectFamily(family, options = {}) {
  return collectQuota({ ...options, families: [family] });
}
