/**
 * Minimal timed JSON HTTP helpers.
 *
 * Every outbound request in this project goes through here so that timeouts,
 * redaction of secrets and error normalization stay in one place.
 */

import { readFileSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * The package's own User-Agent, sent on every request that does not set one.
 *
 * Without it Node's fetch announces itself as `node`, a generic HTTP-library
 * name. OpenCode Go's terms ask clients for their own User-Agent and have warned
 * and banned accounts over generic ones, and a usage poller that runs every few
 * minutes against every key of a user is exactly the traffic that gets looked
 * at. Providers that need a specific client string (Antigravity's CLI agent,
 * the dashboard's browser agent) keep setting their own.
 */
export const PACKAGE_USER_AGENT = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return `pi-usage/${pkg.version} (+https://github.com/cad0p/pi-usage)`;
  } catch {
    return "pi-usage (+https://github.com/cad0p/pi-usage)";
  }
})();

/**
 * Copy `headers` and add `User-Agent` unless one is already set (any case).
 *
 * @param {Record<string, string> | undefined} headers
 * @returns {Record<string, string>}
 */
export function withUserAgent(headers) {
  const out = { ...(headers ?? {}) };
  if (!Object.keys(out).some((name) => name.toLowerCase() === "user-agent")) out["User-Agent"] = PACKAGE_USER_AGENT;
  return out;
}

/**
 * Redact credential-looking substrings from arbitrary text before it can reach
 * a log, a terminal or an error message.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "<email>");
  text = text.replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}\b/g, "<jwt>");
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(ya29\.)[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(1\/\/)[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(rt\.[\w.]{4})[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>");
  text = text.replace(/\b((?:__Host-console_session|auth)=)[^;\s]+/gi, "$1<redacted>");
  return text;
}

/**
 * @typedef {Object} HttpResult
 * @property {boolean} ok
 * @property {number} status
 * @property {unknown} [body]      Parsed JSON body when parsing succeeded.
 * @property {string} [text]       Raw body when JSON parsing failed or on error.
 * @property {string} [error]      Redacted, human-readable failure reason.
 * @property {boolean} [authError] True for 401/403, which callers surface as a
 *                                 "sign in again" degradation.
 * @property {string | null} [authMessage] The provider's own error message for a
 *                                 401/403, redacted and length-capped. Callers
 *                                 that need to distinguish "revoked key" from
 *                                 "plan not active" use it; the generic error
 *                                 text stays the same for everyone else.
 */

/**
 * Read a provider's JSON error message from a 401/403 body.
 *
 * The status alone cannot tell a revoked credential from a valid credential
 * whose workspace is not entitled to the product, and both Pi and the vendor
 * return that distinction in the body. Never throws: an unreadable body is
 * simply no detail.
 *
 * @param {{ text?: () => Promise<string> }} response
 * @returns {Promise<string | null>}
 */
async function readAuthMessage(response) {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (!raw || raw.trim() === "") return null;
  let message = null;
  try {
    const body = JSON.parse(raw);
    const value = body?.error?.message ?? body?.message ?? body?.error;
    message = typeof value === "string" ? value : null;
  } catch {
    return null;
  }
  if (!message) return null;
  return redact(message).replace(/\s+/g, " ").trim().slice(0, 120) || null;
}

/**
 * Perform one request and parse a JSON body.
 *
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string,
 *   timeoutMs?: number,
 *   fetchFn?: typeof fetch,
 * }} [options]
 * @returns {Promise<HttpResult>}
 */
export async function requestJson(url, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: options.method ?? "GET",
      headers: withUserAgent(options.headers),
      body: options.body,
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        authError: true,
        authMessage: await readAuthMessage(response),
        error: `sign-in expired (HTTP ${response.status})`,
      };
    }

    if (response.status === 429) {
      const rawHeader = response.headers?.get?.("retry-after")?.trim();
      let retrySec = null;
      if (rawHeader) {
        if (/^\d+$/.test(rawHeader)) {
          retrySec = Number(rawHeader);
        } else {
          const parsed = Date.parse(rawHeader);
          if (!Number.isNaN(parsed)) {
            retrySec = Math.max(0, Math.round((parsed - Date.now()) / 1000));
          }
        }
      }
      return {
        ok: false,
        status: 429,
        error: retrySec !== null
          ? `rate limited (HTTP 429); retry in ${retrySec}s`
          : "rate limited (HTTP 429); retry in a minute",
      };
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {
        // Body is optional: the status alone is enough to report the failure.
      }
      return {
        ok: false,
        status: response.status,
        error: detail
          ? `HTTP ${response.status}: ${redact(detail).replace(/\s+/g, " ")}`
          : `HTTP ${response.status}`,
      };
    }

    const raw = await response.text();
    if (raw.trim() === "") {
      return { ok: true, status: response.status, body: null };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(raw) };
    } catch {
      return {
        ok: false,
        status: response.status,
        text: raw,
        error: "response was not valid JSON",
      };
    }
  } catch (error) {
    const name = /** @type {{ name?: string, message?: string }} */ (error)?.name;
    const message = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    const cause = /** @type {{ cause?: { code?: string, message?: string } }} */ (error)?.cause;
    const causeCode = cause?.code ?? cause?.message;
    const detail = causeCode && typeof causeCode === "string" && !message.includes(causeCode)
      ? `${message}: ${causeCode}`
      : message;
    return {
      ok: false,
      status: 0,
      error: name === "AbortError" ? `timed out after ${timeoutMs}ms` : redact(detail),
    };
  } finally {
    clearTimeout(timeout);
  }
}
