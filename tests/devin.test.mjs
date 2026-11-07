/**
 * Devin provider tests. The snapshot is a fixture in a temp directory; no
 * network call is made and no real credential is used.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_API_SERVER_URL, fetchQuota, loginScope, parseUsageWindows, snapshotPath, snapshotTime } from "../src/providers/devin.js";
import { errorKind } from "../src/providers/error-kind.js";
import { normalizeCredential, resolveProviderSlot } from "../src/auth/pi-auth.js";
import { collectQuota } from "../src/engine.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const TOKEN = "devin-session-token$FAKE-0000";
const SERVER = "https://server.codeium.com";
const HOUR = 3_600_000;

const scopeOf = (token = TOKEN, server = SERVER) => createHash("sha256").update(server + "\0" + token).digest("hex");

/** The shape pi-devin 0.1.14 wrote on 2026-11-07, values kept. */
function snapshot(usage = {}, overrides = {}) {
  return {
    schemaVersion: 1,
    scope: scopeOf(),
    usage: {
      billingStrategy: "BILLING_STRATEGY_QUOTA",
      dailyRemainingPercent: 100,
      weeklyRemainingPercent: 87,
      dailyResetAtMs: NOW + 8 * HOUR,
      weeklyResetAtMs: NOW + 8 * HOUR,
      fetchedAtMs: NOW - 10 * 60_000,
      ...usage,
    },
    ...overrides,
  };
}

/** A temp agent dir: auth.json with a devin login, and pi-devin's snapshot beside it (none for null). */
function agentDir(body = snapshot(), auth = { devin: { type: "oauth", access: TOKEN, refresh: "", expires: NOW + 17 * HOUR, devin: { version: 1, apiServerURL: SERVER, flow: "browser" } } }) {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-devin-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify(auth));
  if (body !== null) {
    mkdirSync(join(directory, "pi-devin"));
    writeFileSync(join(directory, "pi-devin", "account-usage.json"), typeof body === "string" ? body : JSON.stringify(body));
  }
  return { directory, authPath, snapshotFile: join(directory, "pi-devin", "account-usage.json") };
}

function credentialFor(authPath, provider = "devin") {
  const raw = JSON.parse(readFileSync(authPath, "utf8"))[provider];
  const result = normalizeCredential(provider, raw, authPath);
  assert.ok(result, provider + " normalizes");
  return result;
}

const neverFetch = () => {
  throw new Error("the Devin provider must not touch the network");
};

test("devin: pi-devin's login is the devin family and keeps its RPC origin", () => {
  assert.deepEqual(resolveProviderSlot("devin"), { base: "devin", family: "devin", slot: null });
  assert.deepEqual(resolveProviderSlot("devin-2"), { base: "devin", family: "devin", slot: "2" });
  const { authPath } = agentDir();
  const credential = credentialFor(authPath);
  assert.equal(credential.label, "Devin (Pi)");
  assert.equal(credential.apiServerURL, SERVER);
  const mistral = normalizeCredential("mistral", { type: "api_key", key: "k", devin: { apiServerURL: SERVER } }, authPath);
  assert.equal(mistral?.apiServerURL, undefined, "only a devin login carries the origin");
});

test("devin: reads the daily and weekly windows from the snapshot, read-only and offline", async () => {
  const { authPath, snapshotFile } = agentDir();
  const before = readFileSync(snapshotFile, "utf8");
  const mtime = statSync(snapshotFile).mtimeMs;
  const result = await fetchQuota(credentialFor(authPath), { now: NOW, env: {}, fetchFn: neverFetch });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.account, "#1");
  assert.deepEqual(
    result.windows.map((window) => [window.id, window.label, window.usedPercent, window.remainingPercent, window.resetsAt, window.windowSeconds]),
    [
      ["daily", "Daily", 0, 100, new Date(NOW + 8 * HOUR).toISOString(), 86_400],
      ["weekly", "Weekly", 13, 87, new Date(NOW + 8 * HOUR).toISOString(), 604_800],
    ],
  );
  for (const window of result.windows) assert.match(String(window.note), /^as of \d\d:\d\d$/, "every window says when it was read");
  assert.equal(readFileSync(snapshotFile, "utf8"), before, "the snapshot is never rewritten");
  assert.equal(statSync(snapshotFile).mtimeMs, mtime);
  const text = JSON.stringify(result);
  assert.equal(text.includes("FAKE"), false, "the token never reaches the result");
  assert.equal(text.includes(scopeOf()), false, "neither does the scope hash");
});

test("devin: a window whose reset passed since the read shows no stale percentage", async () => {
  const { authPath } = agentDir(snapshot({ dailyRemainingPercent: 4, dailyResetAtMs: NOW - HOUR, weeklyResetAtMs: NOW + 3 * 24 * HOUR }));
  const result = await fetchQuota(credentialFor(authPath), { now: NOW, env: {} });
  const daily = result.windows.find((window) => window.id === "daily");
  const weekly = result.windows.find((window) => window.id === "weekly");
  assert.equal(daily?.usedPercent, null, "96% from the previous day would be a lie");
  assert.equal(daily?.resetsAt, null, "the next reset is not known");
  assert.match(String(daily?.note), /reset since .*send one Devin request/);
  assert.equal(weekly?.usedPercent, 13, "the weekly window still applies");
  assert.equal(result.note, undefined, "one current window is enough to show");

  const { authPath: allReset } = agentDir(snapshot({ dailyResetAtMs: NOW - HOUR, weeklyResetAtMs: NOW - HOUR }));
  const stale = await fetchQuota(credentialFor(allReset), { now: NOW, env: {} });
  assert.equal(stale.ok, true);
  assert.ok(stale.windows.every((window) => window.usedPercent === null));
  assert.match(String(stale.note), /reset since the last read/);
});

test("devin: a reset exactly at the run is already past", async () => {
  const { authPath } = agentDir(snapshot({ dailyRemainingPercent: 4, dailyResetAtMs: NOW }));
  const result = await fetchQuota(credentialFor(authPath), { now: NOW, env: {} });
  assert.equal(result.windows.find((window) => window.id === "daily")?.usedPercent, null);
});

test("devin: a FIFO at the snapshot path is rejected, not waited on", { skip: process.platform === "win32" }, async () => {
  const { directory, authPath } = agentDir(null);
  mkdirSync(join(directory, "pi-devin"));
  execFileSync("mkfifo", [join(directory, "pi-devin", "account-usage.json")]);
  const result = await fetchQuota(credentialFor(authPath), { now: NOW, env: {} });
  assert.match(String(result.error), /unreadable \(not a file\)/);
});

test("devin: a snapshot from another sign-in is not shown", async () => {
  const { authPath } = agentDir(snapshot({}, { scope: scopeOf("devin-session-token$OTHER") }));
  const result = await fetchQuota(credentialFor(authPath), { now: NOW, env: {} });
  assert.equal(result.ok, false);
  assert.deepEqual(result.windows, []);
  assert.match(String(result.error), /another sign-in/);
  assert.equal(result.notConfigured, false);
  assert.equal(errorKind(result.error), "unknown", "not an auth failure: the login itself is fine");
});

test("devin: the scope is pi-devin's hash of the origin and token, with its default origin", () => {
  assert.equal(loginScope({ access: TOKEN, apiServerURL: SERVER }), scopeOf());
  assert.equal(loginScope({ access: TOKEN }), scopeOf(TOKEN, DEFAULT_API_SERVER_URL));
  assert.equal(loginScope({ access: TOKEN, apiServerURL: "https://other.example" }) === scopeOf(), false);
  assert.equal(loginScope({ access: TOKEN, apiServerURL: "https://Server.Codeium.com/" }), scopeOf(), "pi-devin hashes the normalized origin");
  assert.equal(loginScope({}), null);
});

test("devin: a missing, unreadable or foreign snapshot degrades without throwing", async () => {
  const cases = [
    [null, /no Devin quota snapshot yet/],
    ["{not json", /unreadable \(not JSON\)/],
    [JSON.stringify({ ...snapshot(), schemaVersion: 2 }), /unknown format \(schemaVersion 2\)/],
    [JSON.stringify([1, 2]), /unknown format/],
    [JSON.stringify({ ...snapshot(), usage: "x" }), /has no usage/],
    [JSON.stringify(snapshot({ dailyRemainingPercent: "n/a", weeklyRemainingPercent: null })), /no daily or weekly quota/],
    ["x".repeat(70 * 1024), /unreadable \(too large\)/],
  ];
  for (const [body, pattern] of cases) {
    const { authPath } = agentDir(body);
    const result = await fetchQuota(credentialFor(authPath), { now: NOW, env: {} });
    assert.equal(result.ok, false, String(pattern));
    assert.match(String(result.error), pattern);
    assert.notEqual(errorKind(result.error), "missing", "the Omarchy record still says what to do");
    assert.notEqual(errorKind(result.error), "expired");
  }

  const { directory, authPath } = agentDir(null);
  mkdirSync(join(directory, "pi-devin", "account-usage.json"), { recursive: true });
  const directoryResult = await fetchQuota(credentialFor(authPath), { now: NOW, env: {} });
  assert.match(String(directoryResult.error), /unreadable \(not a file\)/);

  const tokenless = await fetchQuota({ family: "devin", slot: null, source: authPath }, { now: NOW, env: {} });
  assert.match(String(tokenless.error), /run \/login devin/);
});

test("devin: the snapshot sits beside the store's auth.json, or where the override says", () => {
  assert.equal(snapshotPath({ source: "/a/agent/auth.json" }, {}), "/a/agent/pi-devin/account-usage.json");
  assert.equal(snapshotPath({ source: "/a/agent/auth.json" }, { PI_QUOTA_DEVIN_USAGE_PATH: "/x/u.json" }), "/x/u.json");
  assert.equal(snapshotPath({ source: "/a/agent/auth.json" }, { PI_QUOTA_DEVIN_USAGE_PATH: "  " }), "/a/agent/pi-devin/account-usage.json");
  assert.equal(snapshotPath({}, {}), null);
});

test("devin: a credit-billed account shows its strategy, not 0%", async () => {
  const { authPath } = agentDir(snapshot({ billingStrategy: "BILLING_STRATEGY_CREDITS", dailyRemainingPercent: undefined, weeklyRemainingPercent: undefined }));
  const result = await fetchQuota(credentialFor(authPath), { now: NOW, env: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.windows, []);
  assert.equal(result.plan, "Credits");
  assert.match(String(result.note), /billed by credits, not a daily\/weekly quota/);
});

test("devin: percentages are clamped and absurd resets ignored", () => {
  const windows = parseUsageWindows({ dailyRemainingPercent: 140, weeklyRemainingPercent: -5, dailyResetAtMs: "soon", weeklyResetAtMs: 1e300, fetchedAtMs: NOW }, NOW);
  assert.deepEqual(windows.map((window) => [window.id, window.usedPercent, window.resetsAt]), [["daily", 0, null], ["weekly", 100, null]]);
});

test("devin: the read time is a clock today and a date otherwise", () => {
  const today = new Date(NOW);
  today.setHours(9, 5, 0, 0);
  assert.equal(snapshotTime(today.getTime(), today.getTime() + HOUR), "09:05");
  const earlier = new Date(today.getTime() - 3 * 24 * HOUR);
  assert.match(snapshotTime(earlier.getTime(), today.getTime()), /^[A-Z][a-z]{2} \d{1,2} 09:05$/);
});

test("devin: collectQuota reads the snapshot beside auth.json and never fetches", async () => {
  const { directory, authPath } = agentDir();
  let fetched = 0;
  const fetchFn = async () => {
    fetched += 1;
    throw new Error("no network");
  };
  const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, families: ["devin"], env: {}, home: directory, stores: [], allowBrowser: false });
  const [result] = report.byFamily.devin;
  assert.equal(result.ok, true);
  assert.equal(result.account, "#1");
  assert.equal(result.windows.length, 2);
  assert.equal(fetched, 0);
  assert.equal(JSON.stringify(report).includes("FAKE"), false);
});

test("devin: every surface shows the windows, and a stale read says why", async () => {
  const { renderProviderLines, renderBoxWidget } = await import("../src/render/panel.js");
  const { plainPalette } = await import("../src/render/theme.js");
  const { buildRecord } = await import("../src/omarchy/record.js");
  const { renderBox } = await import("../extensions/quota-panel.ts");
  const theme = { fg: (_key, text) => text, bold: (text) => text };

  const { authPath } = agentDir();
  const result = { ...(await fetchQuota(credentialFor(authPath), { now: NOW, env: {} })), slot: null };
  const lines = renderProviderLines(result, plainPalette()).join("\n");
  assert.match(lines, /Daily .*100%/);
  assert.match(lines, /Weekly .*87%/);
  const record = buildRecord(result, { now: NOW })?.record;
  assert.equal(record?.ready, true);
  assert.deepEqual(record?.limits.map((limit) => [limit.label, limit.percent]), [["Daily", 0], ["Weekly", 0.13]]);
  assert.match(String(record?.tierLabel), /^as of \d\d:\d\d$/, "the Omarchy header says when pi-devin read the quota");

  const report = { providers: [result], byFamily: { devin: [result] }, generatedAt: new Date(NOW).toISOString(), warnings: [] };
  assert.match(renderBoxWidget(report.providers, plainPalette(), 0).join("\n"), /Devin: .* 0% /, "CLI box row shows the daily window, used");
  const { renderProviderLines: renderOverlayLines } = await import("../extensions/quota-panel.ts");
  const panel = renderOverlayLines(/** @type {any} */ (result), theme, undefined, false).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(panel, /Devin \(Pi\) · as of \d\d:\d\d/, "the /usage header says when pi-devin read the quota");
  assert.match(renderBox(/** @type {any} */ (report), theme, 0).join("\n").replace(/\u001b\[[0-9;]*m/g, ""), /Devin: .* 0% /, "extension box row too");

  const { authPath: staleAuth } = agentDir(snapshot({ dailyResetAtMs: NOW - HOUR, weeklyResetAtMs: NOW - HOUR }));
  const stale = { ...(await fetchQuota(credentialFor(staleAuth), { now: NOW, env: {} })), slot: null };
  const staleRecord = buildRecord(stale, { now: NOW })?.record;
  assert.equal(staleRecord?.usageStatusText, "Usage not visible");
  assert.match(String(staleRecord?.authHelpText), /send one Devin request/);
  assert.match(renderProviderLines(stale, plainPalette()).join("\n"), /reset since/);

  const { authPath: missingAuth } = agentDir(null);
  const missing = { ...(await fetchQuota(credentialFor(missingAuth), { now: NOW, env: {} })), slot: null };
  const missingRecord = buildRecord(missing, { now: NOW })?.record;
  assert.ok(missingRecord, "a login without a snapshot still gets a record");
  assert.match(String(missingRecord?.authHelpText), /no Devin quota snapshot yet/);
});
