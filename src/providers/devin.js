/**
 * Devin quota.
 *
 * Devin (Cognition) serves no public usage API: its quota comes from the
 * private `GetUserStatus` RPC the Devin CLI calls, which needs the CLI's device
 * fingerprint. pi-usage does not make that call. `@buyong/pi-devin`, the Pi
 * provider that owns the `devin` login, already makes it at sign-in and before
 * every Devin model request, and shares the answer with other Pi processes in
 * `<agent dir>/pi-devin/account-usage.json`:
 *
 *   { "schemaVersion": 1, "scope": "<sha256 hex>",
 *     "usage": { "billingStrategy", "dailyRemainingPercent", "weeklyRemainingPercent",
 *                "dailyResetAtMs", "weeklyResetAtMs", "fetchedAtMs" } }
 *
 * This provider reads that file read-only and sends nothing over the network.
 * The file is as fresh as the last Devin request, so every window says when it
 * was read, and a window whose reset has passed since then shows no percentage
 * instead of a number from the previous period.
 *
 * `scope` is pi-devin's `sha256(apiServerURL + "\0" + sessionToken)`. The same
 * hash of the stored login, computed in memory, tells a snapshot of the current
 * sign-in from one left behind by an earlier account.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildWindow, degradedResult, finiteNumber, stringValue } from "../model.js";

/** pi-devin's endpoint when the login does not record one. */
export const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const SCHEMA_VERSION = 1;
const QUOTA_STRATEGY = "BILLING_STRATEGY_QUOTA";
/** The snapshot is a few hundred bytes; anything far larger is not it. */
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;
const SEND_ONE = "send one Devin request in Pi to update it";

const WINDOWS = [
  { id: "daily", label: "Daily", remaining: "dailyRemainingPercent", reset: "dailyResetAtMs", seconds: DAY_SECONDS },
  { id: "weekly", label: "Weekly", remaining: "weeklyRemainingPercent", reset: "weeklyResetAtMs", seconds: WEEK_SECONDS },
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
 * The account label shown by every surface: the base auth.json entry is the
 * family's first account, `#1`; a sibling slot is `#<slot>`.
 *
 * @param {{ slot?: string | null }} credential
 * @returns {string}
 */
function accountLabel(credential) {
  return credential.slot ? `#${credential.slot}` : "#1";
}

/**
 * Where pi-devin keeps the snapshot for the store a credential came from: the
 * agent directory is the one holding `auth.json`.
 *
 * @param {{ source?: string }} credential
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function snapshotPath(credential, env = process.env) {
  const override = env.PI_QUOTA_DEVIN_USAGE_PATH;
  if (typeof override === "string" && override.trim() !== "") return override;
  if (typeof credential.source !== "string" || credential.source === "") return null;
  return join(dirname(credential.source), "pi-devin", "account-usage.json");
}

/**
 * pi-devin's scope for a login, or null when the login has no token.
 *
 * @param {{ access?: string, apiServerURL?: string | null }} credential
 * @returns {string | null}
 */
export function loginScope(credential) {
  if (!credential.access) return null;
  const server = credential.apiServerURL || DEFAULT_API_SERVER_URL;
  return createHash("sha256").update(`${server}\0${credential.access}`).digest("hex");
}

/**
 * Read the snapshot file read-only, bounded in size.
 *
 * @param {string} path
 * @returns {{ ok: true, body: unknown } | { ok: false, missing: boolean, reason: string }}
 */
function readSnapshot(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, missing: true, reason: "absent" };
    return { ok: false, missing: false, reason: code ?? "open failed" };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { ok: false, missing: false, reason: "not a file" };
    if (stats.size > MAX_SNAPSHOT_BYTES) return { ok: false, missing: false, reason: "too large" };
    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    try {
      return { ok: true, body: JSON.parse(buffer.subarray(0, offset).toString("utf8")) };
    } catch {
      return { ok: false, missing: false, reason: "not JSON" };
    }
  } catch (error) {
    return { ok: false, missing: false, reason: /** @type {{ code?: string }} */ (error)?.code ?? "read failed" };
  } finally {
    closeSync(fd);
  }
}

/**
 * "14:03" for a time today, "Nov 6 14:03" otherwise, in local time.
 *
 * @param {number} ms
 * @param {number} now
 * @returns {string}
 */
export function snapshotTime(ms, now) {
  const at = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  if (sameDay) return clock;
  const month = at.toLocaleString("en-US", { month: "short" });
  return `${month} ${at.getDate()} ${clock}`;
}

/**
 * A remaining percentage, or null when the field is absent or not a number.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function percent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

/**
 * An epoch-ms reset, or null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function epochMs(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 && number < 8.64e15 ? number : null;
}

/**
 * Map the snapshot's `usage` object onto canonical windows.
 *
 * A window whose reset is at or before `now` was read in the previous period:
 * the number no longer applies and the next reset is not known, so the window
 * keeps its place with no percentage and says why.
 *
 * @param {Record<string, unknown>} usage
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow[]}
 */
export function parseUsageWindows(usage, now = Date.now()) {
  const fetchedAt = epochMs(usage.fetchedAtMs);
  const asOf = fetchedAt !== null ? `as of ${snapshotTime(fetchedAt, now)}` : null;
  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  for (const spec of WINDOWS) {
    const remaining = percent(usage[spec.remaining]);
    const resetAt = epochMs(usage[spec.reset]);
    const resetPassed = resetAt !== null && resetAt <= now;
    if (resetPassed) {
      windows.push(
        buildWindow({
          id: spec.id,
          label: spec.label,
          usedPercent: null,
          windowSeconds: spec.seconds,
          note: `reset since ${asOf ? asOf.slice(6) : "the last read"}; ${SEND_ONE}`,
          now,
        }),
      );
      continue;
    }
    if (remaining === null) continue;
    windows.push(
      buildWindow({
        id: spec.id,
        label: spec.label,
        remainingPercent: remaining,
        resetsAt: resetAt !== null ? new Date(resetAt).toISOString() : null,
        windowSeconds: spec.seconds,
        note: asOf,
        now,
      }),
    );
  }
  return windows;
}

/**
 * "Credits" for "BILLING_STRATEGY_CREDITS": a display string only.
 *
 * @param {string} strategy
 * @returns {string}
 */
function strategyName(strategy) {
  const words = strategy
    .replace(/^BILLING_STRATEGY_/, "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
  const name = words.join(" ").slice(0, 30);
  return name === "" ? "unknown" : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential & { apiServerURL?: string | null }} credential
 * @param {{
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   expiresInMin?: number | null,
 * }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const base = {
    family: "devin",
    label: "Devin (Pi)",
    account: accountLabel(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };
  const fail = (error) => degradedResult({ ...base, error, now });

  const scope = loginScope(credential);
  if (!scope) return fail("no Devin session token stored in the Pi store; run /login devin in Pi");

  const path = snapshotPath(credential, options.env ?? process.env);
  if (!path) return fail(`no Devin quota snapshot location; ${SEND_ONE}`);

  const read = readSnapshot(path);
  if (!read.ok) {
    return fail(
      read.missing
        ? "no Devin quota snapshot yet: pi-devin writes it at sign-in and on each Devin request"
        : `Devin quota snapshot unreadable (${read.reason})`,
    );
  }

  const root = record(read.body);
  if (!root || root.schemaVersion !== SCHEMA_VERSION) {
    return fail(`Devin quota snapshot has an unknown format (schemaVersion ${JSON.stringify(root?.schemaVersion ?? null)})`);
  }
  if (root.scope !== scope) {
    return fail(`the Devin quota snapshot belongs to another sign-in; ${SEND_ONE}`);
  }
  const usage = record(root.usage);
  if (!usage) return fail("Devin quota snapshot has no usage");

  const strategy = stringValue(usage.billingStrategy);
  if (strategy && strategy !== QUOTA_STRATEGY) {
    // Credit-billed accounts have no daily or weekly percentage; 0% would lie.
    return {
      ...base,
      plan: strategyName(strategy),
      windows: [],
      note: `billed by ${strategyName(strategy).toLowerCase()}, not a daily/weekly quota`,
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  }

  const windows = parseUsageWindows(usage, now);
  if (windows.length === 0) return fail("Devin quota snapshot has no daily or weekly quota");
  // Every window rolled over since the read: nothing current to show, and the
  // surfaces that only draw percentages need to say why.
  const allReset = windows.every((window) => window.usedPercent === null);
  return {
    ...base,
    plan: null,
    windows,
    ...(allReset ? { note: `the quota reset since the last read; ${SEND_ONE}` } : {}),
    error: null,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  };
}
