/**
 * Mistral quota.
 *
 * Pi's built-in `mistral` provider stores an API key (a Vibe key or a
 * la Plateforme key; Mistral accepts either on the same API). The plan's usage
 * is served by Mistral's public billing API, the same two reads the Vibe CLI
 * makes for its footer gauge (`vibe/app_server/_billing.py`):
 *
 *   GET /v1/billing/subscription -> plan_name, payg_enabled, vibe_payg_enabled
 *   GET /v1/billing/budget       -> vibe_budget, api_budget: usage_percentage,
 *                                   initial_budget, currency, reset_at, payg_enabled
 *
 * Both are read-only GETs that cost no tokens. `/budget` needs the
 * `see_org_inference_usage` permission, so a member without it still gets the
 * plan, with a note instead of windows. The key is sent only as a Bearer header
 * to api.mistral.ai and never appears in a result.
 */

import { buildWindow, clampPercent, degradedResult, stringValue } from "../model.js";
import { requestJson } from "../http.js";

const API_BASE = "https://api.mistral.ai/v1";
const SUBSCRIPTION_URL = `${API_BASE}/billing/subscription`;
const BUDGET_URL = `${API_BASE}/billing/budget`;

/** A monthly budget, in the order every surface lists them. */
const BUDGETS = [
  { field: "vibe_budget", id: "vibe", label: "Vibe monthly" },
  { field: "api_budget", id: "api", label: "API monthly" },
];

const MONTH_SECONDS = 2_592_000;

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
 * numeric suffix, so it gets no number; a sibling slot is `#<slot>`.
 *
 * @param {{ slot?: string | null }} credential
 * @returns {string}
 */
function accountLabel(credential) {
  return credential.slot ? `#${credential.slot}` : "";
}

/**
 * "127.50 EUR", or null when the budget carries no usable amount.
 *
 * @param {unknown} amount
 * @param {unknown} currency
 * @returns {string | null}
 */
function money(amount, currency) {
  const value = typeof amount === "number" ? amount : typeof amount === "string" && amount.trim() !== "" ? Number(amount) : NaN;
  if (!Number.isFinite(value) || value < 0) return null;
  const code = stringValue(currency);
  const safeCode = code && /^[A-Za-z]{3}$/.test(code) ? ` ${code.toUpperCase()}` : "";
  return `${value.toFixed(2)}${safeCode}`;
}

/**
 * Map a `/billing/budget` body onto canonical windows.
 *
 * Mistral also repeats one budget at the top level of the body (today the API
 * one); it is read only when neither named budget is present, so an older or
 * smaller answer still shows something and a full answer never shows a budget
 * twice.
 *
 * @param {unknown} body
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow[]}
 */
export function parseBudgetWindows(body, now = Date.now()) {
  const root = record(body);
  if (!root) return [];

  /** @type {Array<{ id: string, label: string, entry: Record<string, unknown> }>} */
  const found = [];
  for (const spec of BUDGETS) {
    const entry = record(root[spec.field]);
    if (entry) found.push({ id: spec.id, label: spec.label, entry });
  }
  if (found.length === 0 && root.usage_percentage !== undefined) {
    found.push({ id: "budget", label: "Monthly budget", entry: root });
  }

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  for (const { id, label, entry } of found) {
    // No readable percentage, no window: "n/a" must not become an empty bar.
    if (clampPercent(entry.usage_percentage) === null) continue;
    const notes = [];
    const amount = money(entry.initial_budget, entry.currency);
    if (amount) notes.push(`of ${amount}`);
    if (entry.payg_enabled === true) notes.push("pay-as-you-go");
    windows.push(
      buildWindow({
        id,
        label,
        usedPercent: entry.usage_percentage,
        resetsAt: entry.reset_at ?? null,
        windowSeconds: MONTH_SECONDS,
        note: notes.length > 0 ? notes.join(" · ") : null,
        now,
      }),
    );
  }
  return windows;
}

/**
 * The plan's name from a `/billing/subscription` body, or null.
 *
 * @param {unknown} body
 * @returns {string | null}
 */
export function parsePlanName(body) {
  const name = stringValue(record(body)?.plan_name);
  if (!name) return null;
  // A display string only: keep it short and free of control characters.
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
  return clean === "" ? null : clean;
}

/**
 * @param {import("../http.js").HttpResult} response
 * @param {string} what
 * @returns {string}
 */
function failureMessage(response, what) {
  if (response.status === 401) return "Mistral key rejected (401); run /login mistral in Pi";
  if (response.status === 403) return `Mistral ${what} not readable with this key (403)`;
  if (response.status === 404) return `Mistral billing API not served (404 on ${what})`;
  return `Mistral ${what} request failed: ${response.error ?? `HTTP ${response.status}`}`;
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{
 *   now?: number,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   expiresInMin?: number | null,
 * }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const base = {
    family: "mistral",
    label: "Mistral (Pi)",
    account: accountLabel(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };

  if (!credential.key) {
    return degradedResult({ ...base, error: "no key stored for mistral in the Pi store; run /login mistral in Pi", now });
  }

  const request = (url) =>
    requestJson(url, {
      headers: { Authorization: `Bearer ${credential.key}`, Accept: "application/json" },
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
    });
  const [subscription, budget] = await Promise.all([request(SUBSCRIPTION_URL), request(BUDGET_URL)]);

  const plan = subscription.ok ? parsePlanName(subscription.body) : null;

  // A rejected key is a statement about the credential: report it once, as an
  // auth failure, whichever read noticed it.
  if (subscription.status === 401 || budget.status === 401) {
    return degradedResult({ ...base, plan, error: failureMessage({ status: 401 }, "billing"), now });
  }

  if (budget.ok) {
    const windows = parseBudgetWindows(budget.body, now);
    if (windows.length === 0) {
      return degradedResult({ ...base, plan, error: "Mistral budget endpoint returned no budgets", now });
    }
    return {
      ...base,
      plan,
      windows,
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  }

  // Without the usage permission the plan is still worth showing: the account
  // works, it just cannot see the organisation's budget.
  if (budget.status === 403 && subscription.ok) {
    return {
      ...base,
      plan,
      windows: [],
      note: "budget needs the see_org_inference_usage permission",
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  }

  return degradedResult({ ...base, plan, error: failureMessage(budget, "budget"), now });
}
