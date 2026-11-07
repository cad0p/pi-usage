/**
 * Mistral provider tests. Every response is a fixture; no network call is made
 * and no real credential is used.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchQuota, mergeSharedBudgets, parseBudgetWindows, parsePlanName } from "../src/providers/mistral.js";
import { errorKind, isRecoverableError } from "../src/providers/error-kind.js";
import { normalizeCredential, resolveProviderSlot } from "../src/auth/pi-auth.js";
import { collectQuota } from "../src/engine.js";
import { jsonResponse, routedFetch } from "./helpers.mjs";
import { buildRecords } from "../src/omarchy/record.js";
import { renderPanel } from "../src/render/panel.js";
import { plainPalette } from "../src/render/theme.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const KEY = "mistral-FAKE-key-0000";

/** The shape Mistral answered with on 2026-11-07, amounts and dates kept. */
function budgetBody(overrides = {}) {
  return {
    vibe_budget: { usage_percentage: 81.053541208, initial_budget: 127.5, currency: "EUR", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
    api_budget: { usage_percentage: 100.0, initial_budget: 12.75, currency: "EUR", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
    usage_percentage: 100.0,
    initial_budget: 12.75,
    currency: "EUR",
    reset_at: "2026-12-01T00:00:00Z",
    ...overrides,
  };
}

const subscriptionBody = { plan_name: "EDU", payg_enabled: false, vibe_payg_enabled: false, enterprise: false };

function credential(provider = "mistral") {
  const result = normalizeCredential(provider, { type: "api_key", key: KEY }, "/tmp/auth.json");
  assert.ok(result, `${provider} normalizes`);
  return result;
}

function routes({ subscription = () => jsonResponse(subscriptionBody), budget = () => jsonResponse(budgetBody()) } = {}) {
  return routedFetch([
    ["api.mistral.ai/v1/billing/subscription", subscription],
    ["api.mistral.ai/v1/billing/budget", budget],
  ]);
}

test("mistral: Pi's mistral key and its numbered siblings are one family", () => {
  assert.deepEqual(resolveProviderSlot("mistral"), { base: "mistral", family: "mistral", slot: null });
  assert.deepEqual(resolveProviderSlot("mistral-1-api"), { base: "mistral", family: "mistral", slot: "1-api" });
  assert.equal(resolveProviderSlot("mistral-api"), null, "a suffix without a leading number is not a slot");
  assert.equal(credential().label, "Mistral (Pi)");
});

test("mistral: reads the Vibe and API monthly budgets and the plan", async () => {
  const { fetchFn, calls } = routes();
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });

  assert.equal(result.ok, true);
  assert.equal(result.family, "mistral");
  assert.equal(result.plan, "EDU");
  assert.equal(result.account, "#1", "the base entry is the family's first account");
  assert.deepEqual(result.windows.map((window) => [window.id, window.label]), [["vibe", "Vibe monthly"], ["api", "API monthly"]]);
  assert.equal(result.windows[0].usedPercent, 81.053541208);
  assert.equal(result.windows[1].remainingPercent, 0);
  assert.equal(result.windows[0].resetsAt, "2026-12-01T00:00:00.000Z");
  assert.equal(result.windows[0].resetsInSec, (Date.parse("2026-12-01T00:00:00Z") - NOW) / 1000);
  assert.equal(result.windows[0].windowSeconds, 2_592_000);
  assert.equal(result.windows[0].note, "of 127.50 EUR");
  assert.equal(result.windows[1].note, "of 12.75 EUR");

  // Two read-only GETs, both to api.mistral.ai, the key only in the header.
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    "https://api.mistral.ai/v1/billing/budget",
    "https://api.mistral.ai/v1/billing/subscription",
  ]);
  for (const call of calls) {
    assert.equal(call.init.method ?? "GET", "GET");
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  }
  assert.equal(JSON.stringify(result).includes(KEY), false, "the key never reaches the result");
});

test("mistral: a sibling slot is labelled by its slot", async () => {
  const { fetchFn } = routes();
  const sibling = credential("mistral-1-api");
  assert.equal(sibling.slot, "1-api");
  const result = await fetchQuota(sibling, { now: NOW, fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.account, "#1-api");
});

test("mistral: pay-as-you-go is named on the budget that has it", async () => {
  const body = budgetBody();
  body.vibe_budget.payg_enabled = true;
  const { fetchFn } = routes({ budget: () => jsonResponse(body) });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  assert.equal(result.windows[0].note, "of 127.50 EUR · pay-as-you-go");
  assert.equal(result.windows[1].note, "of 12.75 EUR");
});

test("mistral: without the usage permission the plan still shows, with a note and no error", async () => {
  const { fetchFn } = routes({ budget: () => jsonResponse({ detail: "forbidden" }, { status: 403 }) });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.plan, "EDU");
  assert.deepEqual(result.windows, []);
  assert.match(result.note ?? "", /see_org_inference_usage/);
});

test("mistral: a 403 on both reads is an auth problem, not a silent empty card", async () => {
  const forbidden = () => jsonResponse({ detail: "forbidden" }, { status: 403 });
  const { fetchFn } = routes({ subscription: forbidden, budget: forbidden });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.equal(errorKind(result.error), "auth");
});

test("mistral: a rejected key is one auth failure, whichever read saw it", async () => {
  for (const which of ["subscription", "budget"]) {
    const rejected = () => jsonResponse({ message: "Unauthorized" }, { status: 401 });
    const { fetchFn } = routes({ [which]: rejected });
    const result = await fetchQuota(credential(), { now: NOW, fetchFn });
    assert.equal(result.ok, false, which);
    assert.match(result.error ?? "", /Mistral key rejected \(401\); run \/login mistral in Pi/, which);
    assert.equal(errorKind(result.error), "auth", which);
    assert.equal(result.windows.length, 0, which);
  }
});

test("mistral: a 429 stays throttled so the family backs off", async () => {
  const { fetchFn } = routes({ budget: () => jsonResponse({}, { status: 429, headers: { "retry-after": "30" } }) });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.equal(errorKind(result.error), "throttle");
  assert.equal(result.plan, "EDU", "the plan that did arrive is kept");
});

test("mistral: a server error or a timeout is transient", async () => {
  const { fetchFn } = routes({ budget: () => jsonResponse({}, { status: 503 }) });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.ok(isRecoverableError(result.error), result.error ?? "");

  const hang = async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  const timedOut = await fetchQuota(credential(), { now: NOW, fetchFn: /** @type {any} */ (hang), timeoutMs: 5 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error ?? "", /timed out/);
});

test("mistral: a 404 says the billing API is not served", async () => {
  const gone = () => jsonResponse({}, { status: 404 });
  const { fetchFn } = routes({ subscription: gone, budget: gone });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /billing API not served \(404/);
});

test("mistral: an entry without a key is not configured, and nothing is sent", async () => {
  const { fetchFn, calls } = routes();
  const keyless = { ...credential(), key: undefined };
  const result = await fetchQuota(keyless, { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.equal(errorKind(result.error), "missing");
  assert.equal(calls.length, 0);
});

test("mistral: malformed budgets degrade instead of inventing a percentage", async () => {
  assert.deepEqual(parseBudgetWindows(null, NOW), []);
  assert.deepEqual(parseBudgetWindows([], NOW), []);
  assert.deepEqual(parseBudgetWindows({ vibe_budget: { usage_percentage: null } }, NOW), []);
  assert.deepEqual(parseBudgetWindows({ vibe_budget: { usage_percentage: "n/a" } }, NOW), []);
  assert.deepEqual(parseBudgetWindows({ vibe_budget: "full" }, NOW), []);

  const clamped = parseBudgetWindows({ vibe_budget: { usage_percentage: 140, initial_budget: -3, currency: "€\u001b[31m" } }, NOW);
  assert.equal(clamped.length, 1);
  assert.equal(clamped[0].usedPercent, 100, "an over-spent budget is clamped to 100");
  assert.equal(clamped[0].note, null, "a negative amount and a non-ISO currency are not printed");
  assert.equal(clamped[0].resetsAt, null);

  const { fetchFn } = routes({ budget: () => jsonResponse({ vibe_budget: { usage_percentage: "n/a" } }) });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /returned no budgets/);

  const { fetchFn: garbage } = routes({ budget: () => jsonResponse(null, { text: "<html>" }) });
  const unreadable = await fetchQuota(credential(), { now: NOW, fetchFn: garbage });
  assert.equal(unreadable.ok, false);
});

test("mistral: the top-level budget is read only when no named budget is present", () => {
  const named = parseBudgetWindows(budgetBody(), NOW);
  assert.deepEqual(named.map((window) => window.id), ["vibe", "api"], "a full answer never shows a budget twice");
  const legacy = parseBudgetWindows({ usage_percentage: 40, initial_budget: 10, currency: "usd", reset_at: "2026-12-01T00:00:00Z" }, NOW);
  assert.deepEqual(legacy.map((window) => [window.id, window.usedPercent, window.note]), [["budget", 40, "of 10.00 USD"]]);
});

test("mistral: the plan name is a short single-line display string", () => {
  assert.equal(parsePlanName({ plan_name: "EDU" }), "EDU");
  assert.equal(parsePlanName({ plan_name: "Pro\u001b[2J\nplan" }), "Pro[2Jplan");
  assert.equal(parsePlanName({ plan_name: "x".repeat(100) })?.length, 40);
  assert.equal(parsePlanName({ plan_name: "  " }), null);
  assert.equal(parsePlanName({}), null);
  assert.equal(parsePlanName("EDU"), null);
});

/** A budget route that answers each key with its own organisation's usage. */
function budgetPerKey(usageByKey) {
  return (_url, init) => {
    const key = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
    const usage = usageByKey[key];
    return jsonResponse(budgetBody(usage === undefined ? {} : { vibe_budget: { ...budgetBody().vibe_budget, usage_percentage: usage } }));
  };
}

test("mistral: collectQuota reports every Mistral slot in auth.json order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-mistral-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    mistral: { type: "api_key", key: "mistral-FAKE-base" },
    "mistral-1-api": { type: "api_key", key: "mistral-FAKE-api" },
    "mistral-api": { type: "api_key", key: "mistral-FAKE-ignored" },
  }));
  // Two organisations: different answers, so two rows.
  const { fetchFn, calls } = routes({ budget: budgetPerKey({ "mistral-FAKE-base": 81.053541208, "mistral-FAKE-api": 12.5 }) });
  const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, families: ["mistral"], env: {}, home: directory, stores: [], allowBrowser: false });
  const results = report.byFamily.mistral;
  assert.deepEqual(results.map((result) => [result.slot ?? null, result.account, result.ok]), [[null, "#1", true], ["1-api", "#1-api", true]]);
  assert.equal(calls.some((call) => String(call.init.headers.Authorization).includes("ignored")), false, "a non-slot suffix is never queried");
  assert.equal(JSON.stringify(report).includes("mistral-FAKE"), false, "no key reaches the report");
});

test("mistral: the compact widgets gain a Mistral row only when a Mistral key is configured", async () => {
  const { renderBoxWidget } = await import("../src/render/panel.js");
  const { plainPalette } = await import("../src/render/theme.js");
  const { renderBox } = await import("../extensions/quota-panel.ts");
  const theme = { fg: (_key, text) => text, bold: (text) => text };
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-mistral-box-"));
  const run = async (auth) => {
    const authPath = join(directory, `auth-${Object.keys(auth).join("-")}.json`);
    writeFileSync(authPath, JSON.stringify(auth));
    const { fetchFn } = routes();
    // The engine's own report: an unconfigured family is still in it, flagged.
    return collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, env: {}, home: directory, stores: [], allowBrowser: false });
  };

  const without = await run({ "opencode-go": { type: "api_key", key: "oc-FAKE" } });
  assert.equal(without.byFamily.mistral[0].notConfigured, true, "the engine reports the family as not configured");
  assert.doesNotMatch(renderBoxWidget(without.providers, plainPalette(), 0).join("\n"), /Mistral/, "CLI box: no permanent not-configured row");
  assert.doesNotMatch(renderBox(without, theme, 0).join("\n"), /Mistral/, "extension box: no permanent not-configured row");

  const configured = await run({ mistral: { type: "api_key", key: "mistral-FAKE-box" } });
  assert.match(renderBoxWidget(configured.providers, plainPalette(), 0).join("\n"), /Mistral:.*81%/, "the row shows the Vibe budget");
  assert.match(renderBox(configured, theme, 0).join("\n"), /Mistral:.*81%/);
});

test("mistral: without the usage permission every surface says why", async () => {
  const { renderProviderLines } = await import("../src/render/panel.js");
  const { plainPalette } = await import("../src/render/theme.js");
  const { buildRecord, buildRecords } = await import("../src/omarchy/record.js");
  const forbidden = () => jsonResponse({ detail: "forbidden" }, { status: 403 });
  const { fetchFn } = routes({ budget: forbidden });
  const quiet = { ...(await fetchQuota(credential(), { now: NOW, fetchFn })), slot: null };

  assert.match(renderProviderLines(quiet, plainPalette()).join("\n"), /see_org_inference_usage/, "the CLI panel prints the note");

  const single = buildRecord(quiet, { now: NOW })?.record;
  assert.equal(single?.usageStatusText, "Usage not visible");
  assert.match(String(single?.authHelpText), /see_org_inference_usage/);
  assert.notEqual(single?.usageStatusText, "Quota unavailable");

  const { fetchFn: healthy } = routes();
  const sibling = { ...(await fetchQuota(credential("mistral-1-api"), { now: NOW, fetchFn: healthy })), slot: "1-api" };
  const family = buildRecords(/** @type {any} */ ({ providers: [quiet, sibling], byFamily: { mistral: [quiet, sibling] } }), { now: NOW })[0].record;
  const base = family.accounts.find((account) => account.id === "#1");
  assert.equal(base.ok, true);
  assert.match(base.status, /see_org_inference_usage/, "the multi-account row says why it is empty");
});

test("mistral: pay-as-you-go reaches the Omarchy title, and falls back to the subscription's flags", async () => {
  const { buildRecord } = await import("../src/omarchy/record.js");
  const body = budgetBody();
  body.vibe_budget.payg_enabled = true;
  const { fetchFn } = routes({ budget: () => jsonResponse(body) });
  const result = await fetchQuota(credential(), { now: NOW, fetchFn });
  const titles = buildRecord(result, { now: NOW })?.record.limits.map((limit) => limit.title);
  assert.deepEqual(titles, ["Vibe monthly · pay-as-you-go", "API monthly"]);

  // A budget without its own flag uses the subscription's for that budget.
  const unflagged = budgetBody();
  delete unflagged.vibe_budget.payg_enabled;
  delete unflagged.api_budget.payg_enabled;
  const { fetchFn: fromSubscription } = routes({
    subscription: () => jsonResponse({ ...subscriptionBody, vibe_payg_enabled: true, payg_enabled: false }),
    budget: () => jsonResponse(unflagged),
  });
  const fallback = await fetchQuota(credential(), { now: NOW, fetchFn: fromSubscription });
  assert.deepEqual(fallback.windows.map((window) => window.note), ["of 127.50 EUR · pay-as-you-go", "of 12.75 EUR"]);

  // The budget's own answer wins over the subscription's.
  const { fetchFn: conflicting } = routes({ subscription: () => jsonResponse({ ...subscriptionBody, vibe_payg_enabled: true }) });
  const own = await fetchQuota(credential(), { now: NOW, fetchFn: conflicting });
  assert.equal(own.windows[0].note, "of 127.50 EUR");

  // Without the usage permission the subscription still says pay-as-you-go is on.
  const { fetchFn: quiet } = routes({
    subscription: () => jsonResponse({ ...subscriptionBody, vibe_payg_enabled: true }),
    budget: () => jsonResponse({}, { status: 403 }),
  });
  const plain = await fetchQuota(credential(), { now: NOW, fetchFn: quiet });
  assert.match(plain.note ?? "", /pay-as-you-go on/);
});

test("mistral: hostile amounts and names are not printed raw", () => {
  const huge = parseBudgetWindows({ vibe_budget: { usage_percentage: 10, initial_budget: 1e308, currency: "EUR" } }, NOW);
  assert.equal(huge[0].note, null, "an absurd amount is not printed as 1e+308");
  assert.equal(parsePlanName({ plan_name: "Pro\u009b2J" }), "Pro2J", "C1 controls are stripped too");
});

test("mistral: an unreadable named budget does not hide a readable top-level one", () => {
  const windows = parseBudgetWindows({ vibe_budget: { usage_percentage: "n/a" }, usage_percentage: 40, initial_budget: 10, currency: "EUR" }, NOW);
  assert.deepEqual(windows.map((window) => [window.id, window.usedPercent]), [["budget", 40]]);
});

test("mistral: the Omarchy record carries both budgets, the plan and no key", async () => {
  const { buildRecords } = await import("../src/omarchy/record.js");
  const { fetchFn } = routes();
  const base = { ...(await fetchQuota(credential(), { now: NOW, fetchFn })), slot: null };
  const sibling = { ...(await fetchQuota(credential("mistral-1-api"), { now: NOW, fetchFn })), slot: "1-api" };
  const report = { providers: [base, sibling], byFamily: { mistral: [base, sibling] }, generatedAt: new Date(NOW).toISOString(), warnings: [] };
  const records = buildRecords(/** @type {any} */ (report), { now: NOW });
  assert.equal(records.length, 1);
  const record = records[0].record;
  assert.equal(record.id, "pi-mistral");
  assert.equal(record.name, "Mistral");
  const text = JSON.stringify(record);
  assert.equal(text.includes(KEY), false);
  assert.match(text, /Vibe monthly/);
  assert.match(text, /API monthly/);
  assert.deepEqual(record.accounts.map((account) => account.id), ["#1", "#1-api"]);
  for (const account of record.accounts) {
    for (const limit of account.limits) assert.ok(limit.percent >= 0 && limit.percent <= 1, JSON.stringify(limit));
  }
});


test("mistral: keys of one organisation answer one budget and merge into one row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-mistral-merge-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    mistral: { type: "api_key", key: "mistral-FAKE-base" },
    "mistral-1-api": { type: "api_key", key: "mistral-FAKE-api" },
    "mistral-2": { type: "api_key", key: "mistral-FAKE-other" },
  }));
  // #1 and #1-api: the same organisation (identical answers); #2 another one.
  const { fetchFn, calls } = routes({ budget: budgetPerKey({ "mistral-FAKE-other": 33.25 }) });
  const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, families: ["mistral"], env: {}, home: directory, stores: [], allowBrowser: false });
  const results = report.byFamily.mistral;
  assert.equal(calls.length, 6, "every key is still asked: the answers are the identity");
  assert.deepEqual(results.map((result) => [result.slot ?? null, result.sharedSlots ?? null]), [[null, [null, "1-api"]], ["2", null]]);
  assert.match(String(results[0].note), /#1 and #1-api share one organisation budget/);
  assert.equal(results[1].note ?? null, null);
  assert.deepEqual(report.providers.filter((provider) => provider.family === "mistral").length, 2, "the flattened list carries the merged row once");

  // Every surface labels the merged row with both slots.
  const record = buildRecords(/** @type {any} */ (report), { now: NOW }).find((entry) => entry.record.id === "pi-mistral").record;
  assert.deepEqual(record.accounts.map((account) => account.id), ["#1 · #1-api", "#2"]);
  assert.equal(record.tierLabel, "2 of 2 accounts");
  const panel = renderPanel(results, plainPalette()).join("\n");
  assert.match(panel, /Mistral \(Pi\) #1 · #1-api · plan EDU/, "the CLI title names both keys");
  const { renderProviderLines: extensionLines } = await import("../extensions/quota-panel.ts");
  const theme = { fg: (_key, text) => text, bold: (text) => text };
  assert.match(extensionLines(results[0], /** @type {any} */ (theme), undefined, false).join("\n"), /share one organisation budget/);

  // The session scan counts tokens per key; the merged /usage row sums its keys.
  const { renderAccountRows } = await import("../extensions/quota-panel.ts");
  const stats = { byAccount: { "#1": { todayTokens: 1_000_000 }, "#1-api": { todayTokens: 500_000 }, "#2": { todayTokens: 250_000 } } };
  const rows = renderAccountRows(/** @type {any} */ (results), /** @type {any} */ (theme), /** @type {any} */ (stats));
  assert.match(rows.find((line) => line.includes("#1 · #1-api")) ?? "", /1\.5M today/, "both keys' tokens on the merged row");
  assert.match(rows.find((line) => /#2 /.test(line)) ?? "", /250k today/);
});

test("mistral: a fresh or spent budget does not identify an organisation, so it never merges", () => {
  const row = (slot, used, extra = {}) => ({
    family: "mistral", label: "Mistral (Pi)", account: slot ? `#${slot}` : "#1", slot, plan: "EDU", ok: true, error: null, updatedAt: "x", source: "s", expiresInMin: null,
    windows: [{ id: "vibe", label: "Vibe monthly", usedPercent: used, remainingPercent: 100 - used, resetsAt: "2026-12-01T00:00:00.000Z", resetsInSec: 1, windowSeconds: 1, note: "of 127.50 EUR" },
      { id: "api", label: "API monthly", usedPercent: 100, remainingPercent: 0, resetsAt: "2026-12-01T00:00:00.000Z", resetsInSec: 1, windowSeconds: 1, note: "of 12.75 EUR" }],
    ...extra,
  });
  // 0 % and 100 %: two fresh organisations answer exactly this.
  assert.equal(mergeSharedBudgets([row(null, 0), row("1-api", 0)]).length, 2);
  assert.equal(mergeSharedBudgets([row(null, 100), row("1-api", 100)]).length, 2);
  // Any difference keeps two rows: usage, plan, reset or note.
  assert.equal(mergeSharedBudgets([row(null, 40.5), row("1-api", 40.25)]).length, 2);
  assert.equal(mergeSharedBudgets([row(null, 40.5), row("1-api", 40.5, { plan: "Pro" })]).length, 2);
  const otherNote = row("1-api", 40.5);
  otherNote.windows[1] = { ...otherNote.windows[1], note: "of 12.75 EUR · pay-as-you-go" };
  assert.equal(mergeSharedBudgets([row(null, 40.5), otherNote]).length, 2);
  // A failed key, or one without windows, is never folded into a healthy row.
  const failed = { ...row("1-api", 40.5), ok: false, error: "Mistral key rejected (401); run /login mistral in Pi" };
  assert.deepEqual(mergeSharedBudgets([row(null, 40.5), failed]).map((result) => result.ok), [true, false]);
  const plain = { ...row("1-api", 40.5), windows: [] };
  assert.equal(mergeSharedBudgets([row(null, 40.5), plain]).length, 2);
  // A family whose only row is merged has no account column: the record header names the keys.
  const pair = mergeSharedBudgets([row(null, 40.5), row("1-api", 40.5)]);
  const single = buildRecords(/** @type {any} */ ({ providers: pair, byFamily: { mistral: pair } }), { now: NOW })[0].record;
  assert.equal(single.tierLabel, "EDU · keys #1 · #1-api");
  assert.equal(single.accounts, undefined);
  assert.match(renderPanel(pair, plainPalette()).join("\n"), /Mistral \(Pi\) #1 · #1-api · plan EDU/, "the CLI names the keys of a lone merged row too");
  // Three keys of one organisation: one row, every slot in order, the note names them all.
  const three = mergeSharedBudgets([row(null, 40.5), row("1-api", 40.5), row("2", 40.5, { note: "kept" })]);
  assert.equal(three.length, 1);
  assert.deepEqual(three[0].sharedSlots, [null, "1-api", "2"]);
  assert.equal(three[0].note, "#1, #1-api and #2 share one organisation budget");
});

test("mistral: Mistral is the only family with a merge rule (per-key budgets never merge)", async () => {
  const { readFileSync } = await import("node:fs");
  const engine = readFileSync(new URL("../src/engine.js", import.meta.url), "utf8");
  const block = engine.slice(engine.indexOf("const MERGE_SHARED = {"), engine.indexOf("};", engine.indexOf("const MERGE_SHARED = {")));
  assert.deepEqual([...block.matchAll(/^\s+([\w"-]+):/gm)].map((match) => match[1]), ["mistral"]);
});
