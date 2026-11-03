/**
 * OpenCode Go quota.
 *
 * The `opencode-go` entry in Pi's store is an OpenCode Zen API key. That key is
 * enough to read the Go plan windows directly from the usage endpoint
 * (`GET /zen/go/v1/usage` -> rolling/weekly/monthly), so no browser session is
 * needed for the common case, and every numbered sibling account can report its
 * own windows.
 *
 * The authenticated dashboard (src/opencode/session.js) remains as a fallback
 * for two cases only: the key usage endpoint answers 404, or the entry has no
 * key at all. A browser session belongs to one workspace, so the fallback is
 * limited to the base account and is never duplicated under every sibling.
 *
 * This provider never breaks the report: every failure is a precise,
 * actionable message.
 */

import { buildWindow, degradedResult, displayIdentity, stringValue } from "../model.js";
import { requestJson } from "../http.js";
import { readGoPlan, resolveCookie } from "../opencode/session.js";

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

/** Canonical window order, shortest first. */
const GO_WINDOWS = [
  { field: "rolling", id: "5h", label: "5h window", windowSeconds: 18_000 },
  { field: "weekly", id: "weekly", label: "Weekly window", windowSeconds: 604_800 },
  { field: "monthly", id: "monthly", label: "Monthly window", windowSeconds: 2_592_000 },
];

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * The account label shown by every surface: the base auth.json entry has no
 * numeric suffix, so it gets no number; only a real sibling slot is `#<slot>`.
 * The key itself never appears.
 *
 * @param {{ slot?: string | null }} credential
 * @returns {string}
 */
function accountLabel(credential) {
  return credential.slot ? `#${credential.slot}` : "";
}

/**
 * Map the usage endpoint body onto canonical windows.
 *
 * A non-"ok" status (e.g. "rate-limited") is carried in the window note so the
 * panel can explain a 100% window instead of implying the plan is merely spent.
 *
 * @param {unknown} body
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow[]}
 */
export function parseUsageWindows(body, now = Date.now()) {
  const usage = record(record(body)?.usage);
  if (!usage) return [];

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  for (const spec of GO_WINDOWS) {
    const entry = record(usage[spec.field]);
    if (!entry) continue;
    if (typeof entry.percent !== "number" && typeof entry.percent !== "string") continue;
    const status = stringValue(entry.status);
    windows.push(
      buildWindow({
        id: spec.id,
        label: spec.label,
        usedPercent: entry.percent,
        resetsAt: entry.resetAt ?? entry.resetsAt,
        windowSeconds: spec.windowSeconds,
        note: status && status.toLowerCase() !== "ok" ? status : null,
        now,
      }),
    );
  }
  return windows;
}

/**
 * Ask the usage endpoint for one key.
 *
 * @param {{ key?: string }} credential
 * @param {{ now?: number, fetchFn?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<
 *   | { status: "ok", windows: import("../model.js").QuotaWindow[] }
 *   | { status: "fallback", reason: "no-key" | "gone" }
 *   | { status: "error", message: string }
 * >}
 */
async function fetchKeyUsage(credential, options = {}) {
  if (!credential.key) return { status: "fallback", reason: "no-key" };

  const response = await requestJson(GO_USAGE_URL, {
    headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  if (response.ok) {
    const windows = parseUsageWindows(response.body, options.now ?? Date.now());
    if (windows.length === 0) {
      return { status: "error", message: "OpenCode Go usage endpoint returned no usage windows" };
    }
    return { status: "ok", windows };
  }
  // A 404 means the endpoint is gone. Every other status is a real answer about
  // this key, so falling back to a browser session would mask it.
  if (response.status === 404) return { status: "fallback", reason: "gone" };

  if (response.status === 401) {
    return { status: "error", message: "OpenCode Go key rejected (401); reconnect that account in Pi" };
  }
  if (response.status === 403) {
    const detail = response.authMessage ? ` ${response.authMessage}` : "";
    return { status: "error", message: `Go plan not active for this key's workspace (403${detail})` };
  }
  return { status: "error", message: `OpenCode Go usage request failed: ${response.error}` };
}

/**
 * Confirm the Zen key still authenticates, so a degradation can distinguish a
 * dead credential from a missing session.
 *
 * @param {string | undefined} key
 * @param {typeof fetch | undefined} fetchFn
 * @param {number | undefined} timeoutMs
 * @returns {Promise<string>}
 */
async function describeZenKey(key, fetchFn, timeoutMs) {
  if (!key) return "no key stored for opencode-go in the Pi store";
  const response = await requestJson(ZEN_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    fetchFn,
    timeoutMs,
  });
  if (response.ok) {
    const body = record(response.body);
    const models = Array.isArray(body?.data) ? body.data.length : 0;
    return `Pi OpenCode key is valid (${models} Zen models visible)`;
  }
  if (response.authError) return "Pi OpenCode key was rejected by OpenCode Zen; reconnect OpenCode in Pi";
  return `OpenCode Zen probe failed: ${response.error}`;
}

/**
 * The browser-session path: one workspace, therefore the base account only.
 *
 * @param {{ key?: string, source?: string }} credential
 * @param {{
 *   now: number,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   stores?: import("../browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 * }} options
 * @returns {Promise<{ ok: true, account: string, plan: string | null, windows: import("../model.js").QuotaWindow[] } | { ok: false, error: string }>}
 */
async function fetchDashboardQuota(credential, options) {
  const session = resolveCookie({
    env: options.env,
    home: options.home,
    stores: options.stores,
    allowBrowser: options.allowBrowser,
  });
  const plan = await readGoPlan({
    env: options.env,
    home: options.home,
    stores: options.stores,
    allowBrowser: options.allowBrowser,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });

  if (plan.ok) {
    return {
      ok: true,
      account: plan.workspaceId
        ? `workspace ${plan.workspaceId.length > 10 ? `${plan.workspaceId.slice(0, 8)}…` : plan.workspaceId}`
        : displayIdentity(credential),
      plan: plan.planHint ?? "Go subscription",
      windows: plan.windows,
    };
  }

  const zen = await describeZenKey(credential.key, options.fetchFn, options.timeoutMs);
  const hint =
    session.origin === "browser"
      ? `the browser session was read from ${session.detail} but was not accepted`
      : session.encryptedOnly
        ? "Chrome on Windows encrypts cookies with DPAPI, which WSL cannot read; log in with Firefox instead"
        : "run: piquota auth opencode";

  return { ok: false, error: `${zen}. Go plan windows unavailable: ${plan.error}. ${hint}` };
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{
 *   now?: number,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   expiresInMin?: number | null,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   stores?: import("../browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 * }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const base = {
    family: "opencode-go",
    label: "OpenCode Go (Pi)",
    account: accountLabel(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };

  const keyResult = await fetchKeyUsage(credential, { ...options, now });
  if (keyResult.status === "ok") {
    return {
      ...base,
      plan: "Go plan",
      windows: keyResult.windows,
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  }
  if (keyResult.status === "error") {
    return degradedResult({ ...base, error: keyResult.message, plan: "Go plan" });
  }

  if (credential.slot) {
    const why =
      keyResult.reason === "gone"
        ? "OpenCode Go usage endpoint returned 404"
        : "no key stored for this OpenCode Go account";
    return degradedResult({
      ...base,
      error: `${why}; the browser-session fallback only covers the base account`,
    });
  }

  const dashboard = await fetchDashboardQuota(credential, { ...options, now });
  if (dashboard.ok) {
    return {
      ...base,
      account: dashboard.account,
      plan: dashboard.plan,
      windows: dashboard.windows,
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  }
  return degradedResult({ ...base, error: dashboard.error });
}
