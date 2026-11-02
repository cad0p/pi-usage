/**
 * Map piQuota's normalized report onto Omarchy's agent usage records.
 *
 * Omarchy's "Agents" bar panel draws whatever `*.json` record it finds in its
 * usage directory. This module is pure: it turns a `PiQuotaReport` into the
 * minimal valid record per provider and never touches the disk, the network or
 * credentials. Only plan names, window labels, percentages and reset times can
 * reach a record; accounts and e-mail addresses are never copied, and every free
 * text field goes through `redact()` first.
 *
 * Record contract (see Omarchy's plugins/agents/Main.qml):
 *   id, name, ready, updatedAt, schemaVersion, tierLabel, usageStatusText,
 *   authHelpText and `limits[{label, title, percent, resetsAt}]`. The local
 *   token statistics are optional and are deliberately left out; the panel
 *   treats their absence as "no local stats".
 *
 * `percent` is a FRACTION in 0..1 (the panel multiplies it by 100), so 40.3% used
 * is written as 0.403.
 */

import { redact } from "../http.js";
import { errorKind } from "../providers/error-kind.js";

export const RECORD_PREFIX = "pi-";
export const SCHEMA_VERSION = 1;

/**
 * Pi's own provider name per family, for the "sign in again" hint.
 */
const LOGIN_HINT = {
  claude: "Run `claude` once, or `/login anthropic` in Pi, to restore usage.",
  codex: "Run `/login openai-codex` in Pi to restore usage.",
  antigravity: "Run `/login antigravity` in Pi to restore usage.",
  "opencode-go": "Run `piquota auth opencode` to restore usage.",
};

const HELP_MAX = 200;

/**
 * The panel hides a provider that has no limits and no local stats. An error
 * record has neither, so it carries one placeholder window with a negative
 * percent: the panel's own filter (`percent >= 0`) never draws it, but its
 * presence keeps the provider's tab, and the status card, on screen.
 */
const PLACEHOLDER_LIMIT = Object.freeze({ label: "Unavailable", title: "Unavailable", percent: -1, resetsAt: "" });

/**
 * @param {string} family
 * @returns {string}
 */
export function recordId(family) {
  return `${RECORD_PREFIX}${family}`;
}

/**
 * @param {string | null | undefined} id
 * @returns {boolean}
 */
export function isPiRecordId(id) {
  return typeof id === "string" && /^pi-[a-z0-9][a-z0-9-]*$/.test(id);
}

/**
 * @param {import("../model.js").QuotaWindow} window
 * @param {import("../model.js").QuotaResult} [provider]
 * @returns {string}
 */
function windowTitle(window, provider) {
  if (provider?.family === "github-actions") {
    const match = typeof window.note === "string"
      ? window.note.match(/(\d+(?:\.\d+)?)\s+of\s+(\d+(?:\.\d+)?)\s+min/i)
      : null;
    const minutesLabel = match ? `${match[1]} / ${match[2]} min` : null;

    let org = "";
    if (window.label && window.label !== "Monthly window" && window.label !== "monthly") {
      org = window.label.replace(/\s+(?:monthly.*|\(monthly.*\))$/i, "").trim();
    }
    if (!org && provider.account) {
      org = provider.account;
    }

    if (minutesLabel) {
      return org ? `${org} (${minutesLabel})` : `Monthly (${minutesLabel})`;
    }
    if (org && org !== "GitHub Actions") {
      return org;
    }
    return "Monthly";
  }

  switch (window.id) {
    case "5h":
      return "Session";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    default:
      return window.label || window.id || "Limit";
  }
}

/**
 * @param {import("../model.js").QuotaWindow[]} windows
 * @param {import("../model.js").QuotaResult} [provider]
 * @param {string} [prefix] Account prefix for a multi-account family, e.g. "#2 · ".
 * @returns {Array<{ label: string, title: string, percent: number, resetsAt: string }>}
 */
function mapLimits(windows, provider, prefix = "") {
  const limits = [];
  for (const window of windows ?? []) {
    // A window without a percentage would otherwise read as "0% used".
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    limits.push({
      label: redact(`${prefix}${window.label || window.id || "Limit"}`),
      title: redact(`${prefix}${windowTitle(window, provider)}`),
      percent: Math.min(1, Math.max(0, window.usedPercent / 100)),
      resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : "",
    });
  }
  return limits;
}

/**
 * @param {string} family
 * @param {string | null | undefined} error
 * @returns {{ usageStatusText: string, authHelpText: string }}
 */
export function describeError(family, error) {
  const kind = errorKind(error);
  const login = LOGIN_HINT[family] ?? "Sign in again to restore usage.";
  switch (kind) {
    case "expired":
      return { usageStatusText: "Sign-in expired", authHelpText: login };
    case "auth":
      return { usageStatusText: "Credential rejected", authHelpText: login };
    case "throttle":
      return { usageStatusText: "Rate limited", authHelpText: "The provider throttled the usage endpoint; piQuota retries on its next run." };
    case "transient":
      return { usageStatusText: "Temporarily unavailable", authHelpText: "The provider did not answer; piQuota retries on its next run." };
    case "missing":
      return { usageStatusText: "Not configured", authHelpText: login };
    default:
      return { usageStatusText: "Quota unavailable", authHelpText: redact(error ?? "no data").slice(0, HELP_MAX) };
  }
}

const SHORT_NAMES = {
  "github-actions": "GH Actions",
  antigravity: "Agy",
  "opencode-go": "OP-Go",
};

/**
 * @param {import("../model.js").QuotaResult} provider
 * @returns {string}
 */
function recordName(provider) {
  if (SHORT_NAMES[provider.family]) {
    return SHORT_NAMES[provider.family];
  }
  return redact(String(provider.label || provider.family).replace(/\s*\(Pi\)\s*$/i, ""));
}

/**
 * @param {import("../model.js").QuotaResult} provider
 * @returns {string}
 */
function recordTierLabel(provider) {
  if (provider.family === "github-actions") {
    const account = provider.account ? redact(provider.account) : "";
    const plan = provider.plan ? redact(provider.plan) : "";
    if (account && plan) return `${account} · ${plan}`;
    return account || plan || "";
  }
  return provider.plan ? redact(provider.plan) : "";
}

/**
 * Slot label of one account: "#1" for the base entry (or the first result when
 * the provider does not carry slots at all), "#<slot>" for a sibling.
 *
 * @param {import("../model.js").QuotaResult} provider
 * @param {number} index
 * @returns {string}
 */
function accountLabel(provider, index) {
  if (typeof provider.slot === "string" && provider.slot !== "") return `#${provider.slot}`;
  if (typeof provider.account === "string" && /^#\d/.test(provider.account)) return provider.account;
  return `#${index + 1}`;
}

/**
 * The window an account is actually constrained by: the most consumed one, and
 * on a tie the one that resets first. Unknown reset times sort last.
 *
 * @param {import("../model.js").QuotaWindow[]} windows
 * @returns {import("../model.js").QuotaWindow | null}
 */
function bindingWindow(windows) {
  /** @type {import("../model.js").QuotaWindow | null} */
  let best = null;
  for (const window of windows ?? []) {
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    if (!best) {
      best = window;
      continue;
    }
    const used = window.usedPercent;
    const bestUsed = /** @type {number} */ (best.usedPercent);
    if (used > bestUsed) {
      best = window;
      continue;
    }
    if (used === bestUsed && resetOrder(window.resetsAt) < resetOrder(best.resetsAt)) best = window;
  }
  return best;
}

/**
 * @param {string | null | undefined} resetsAt
 * @returns {number} Epoch ms, or Infinity when unknown, so unknown resets sort last.
 */
function resetOrder(resetsAt) {
  if (typeof resetsAt !== "string" || resetsAt === "") return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(resetsAt);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * A short, user-facing reason for one failed account.
 *
 * @param {string | null | undefined} error
 * @returns {string}
 */
function failureReason(error) {
  const text = typeof error === "string" ? error : "";
  if (/key rejected|key was rejected/i.test(text)) return "key rejected";
  if (/Go plan not active|Workspace access denied/i.test(text)) return "no Go plan";
  switch (errorKind(error)) {
    case "expired":
      return "sign-in expired";
    case "auth":
      return "credential rejected";
    case "throttle":
      return "rate limited";
    case "transient":
      return "temporarily unavailable";
    case "missing":
      return "not configured";
    default:
      return "unavailable";
  }
}

/**
 * Collapse consecutive numeric account labels into ranges: #8,#9,#10 -> "#8–#10".
 *
 * @param {string[]} labels
 * @returns {string}
 */
function compactLabels(labels) {
  /** @type {string[]} */
  const parts = [];
  /** @type {number | null} */
  let runStart = null;
  /** @type {number | null} */
  let runEnd = null;
  const flush = () => {
    if (runStart === null || runEnd === null) return;
    parts.push(runStart === runEnd ? `#${runStart}` : `#${runStart}–#${runEnd}`);
    runStart = null;
    runEnd = null;
  };
  for (const label of labels) {
    const match = /^#(\d+)$/.exec(label);
    if (!match) {
      flush();
      parts.push(label);
      continue;
    }
    const number = Number(match[1]);
    if (runStart === null || runEnd === null) {
      runStart = number;
      runEnd = number;
    } else if (number === runEnd + 1) {
      runEnd = number;
    } else {
      flush();
      runStart = number;
      runEnd = number;
    }
  }
  flush();
  return parts.join(", ");
}

/**
 * Explain failures compactly, grouped by reason in slot order, e.g.
 * "#8–#10 key rejected · #11–#14 no Go plan".
 *
 * @param {Array<{ label: string, reason: string }>} failures
 * @returns {string}
 */
function compactFailureList(failures) {
  /** @type {string[]} */
  const groups = [];
  let index = 0;
  while (index < failures.length) {
    const reason = failures[index].reason;
    /** @type {string[]} */
    const labels = [];
    while (index < failures.length && failures[index].reason === reason) {
      labels.push(failures[index].label);
      index += 1;
    }
    groups.push(`${compactLabels(labels)} ${reason}`);
  }
  const text = redact(groups.join(" · "));
  return text.length <= HELP_MAX ? text : `${text.slice(0, HELP_MAX - 1).trimEnd()}…`;
}

/**
 * One record for a family with several accounts.
 *
 * Each healthy account contributes only the window that constrains it (the most
 * consumed one), so a fourteen-account family stays a readable tab instead of a
 * wall of forty rows. Failed accounts contribute no rows at all: they are
 * summarised in the status and the compact help text, which is what makes a
 * revoked key distinguishable from a workspace without a plan.
 *
 * @param {string} family
 * @param {import("../model.js").QuotaResult[]} providers
 * @param {{ now?: number }} [options]
 * @returns {{ id: string, record: Record<string, unknown> } | null}
 */
function buildFamilyRecord(family, providers, options = {}) {
  const now = options.now ?? Date.now();
  const first = providers[0];
  if (!first) return null;
  if (providers.every((provider) => !provider.ok && errorKind(provider.error) === "missing")) return null;

  /** @type {Array<{ label: string, title: string, percent: number, resetsAt: string }>} */
  const limits = [];
  /** @type {Array<{ label: string, reason: string }>} */
  const failures = [];
  let okCount = 0;

  providers.forEach((provider, index) => {
    const label = accountLabel(provider, index);
    if (provider.ok) {
      okCount += 1;
      const window = bindingWindow(provider.windows);
      const mapped = window ? mapLimits([window], provider, `${label} · `)[0] : null;
      if (mapped) limits.push(mapped);
      return;
    }
    failures.push({ label, reason: failureReason(provider.error) });
  });

  const failedCount = providers.length - okCount;
  const allFailed = okCount === 0;
  const status = allFailed
    ? describeError(family, first.error ?? "no usage windows")
    : {
        usageStatusText: failedCount > 0 ? `${failedCount} of ${providers.length} accounts unavailable` : "",
        authHelpText: "",
      };

  const id = recordId(family);
  return {
    id,
    record: {
      schemaVersion: SCHEMA_VERSION,
      id,
      name: recordName(first),
      ready: okCount > 0,
      tierLabel: `${okCount} of ${providers.length} accounts`,
      limits: limits.length > 0 ? limits : [{ ...PLACEHOLDER_LIMIT }],
      usageStatusText: status.usageStatusText,
      authHelpText: failures.length > 0 ? compactFailureList(failures) : status.authHelpText,
      hasLocalStats: false,
      hasPromptStats: false,
      updatedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * Build the record for one provider, or `null` when the provider is simply not
 * configured: a tab that only says "not configured" is noise, so it is omitted
 * (and any record from an earlier run is removed by the publisher).
 *
 * @param {import("../model.js").QuotaResult} provider
 * @param {{ now?: number }} [options]
 * @returns {{ id: string, record: Record<string, unknown> } | null}
 */
export function buildRecord(provider, options = {}) {
  const now = options.now ?? Date.now();
  const limits = mapLimits(provider.windows, provider);
  const failed = !provider.ok || limits.length === 0;

  if (failed && errorKind(provider.error) === "missing") return null;

  const status = failed
    ? describeError(provider.family, provider.error ?? "no usage windows")
    : { usageStatusText: "", authHelpText: "" };

  const id = recordId(provider.family);
  return {
    id,
    record: {
      schemaVersion: SCHEMA_VERSION,
      id,
      name: recordName(provider),
      ready: !failed,
      tierLabel: recordTierLabel(provider),
      limits: failed && limits.length === 0 ? [{ ...PLACEHOLDER_LIMIT }] : limits,
      usageStatusText: status.usageStatusText,
      authHelpText: status.authHelpText,
      hasLocalStats: false,
      hasPromptStats: false,
      updatedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * One record per family. A family with a single result produces exactly the same
 * record as before; several accounts collapse into one record with one binding
 * window per healthy account.
 *
 * Never throws: a malformed provider entry is skipped.
 *
 * @param {import("../engine.js").PiQuotaReport} report
 * @param {{ now?: number }} [options]
 * @returns {Array<{ id: string, record: Record<string, unknown> }>}
 */
export function buildRecords(report, options = {}) {
  /** @type {Map<string, import("../model.js").QuotaResult[]>} */
  const groups = new Map();
  for (const provider of report?.providers ?? []) {
    if (!provider || typeof provider.family !== "string") continue;
    const list = groups.get(provider.family) ?? [];
    list.push(provider);
    groups.set(provider.family, list);
  }

  const records = [];
  for (const [family, providers] of groups) {
    try {
      const built = providers.length > 1
        ? buildFamilyRecord(family, providers, options)
        : buildRecord(providers[0], options);
      if (built) records.push(built);
    } catch {
      // A broken entry must not take the other providers' records down with it.
    }
  }
  return records;
}
