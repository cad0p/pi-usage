/**
 * Mistral provider tests. Every response is a fixture; no network call is made
 * and no real credential is used.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchQuota, parseBudgetWindows, parsePlanName } from "../src/providers/mistral.js";
import { errorKind, isRecoverableError } from "../src/providers/error-kind.js";
import { normalizeCredential, resolveProviderSlot } from "../src/auth/pi-auth.js";
import { collectQuota } from "../src/engine.js";
import { jsonResponse, routedFetch } from "./helpers.mjs";

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
  assert.equal(result.account, "", "the base entry carries no number");
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

test("mistral: collectQuota reports every Mistral slot in auth.json order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-mistral-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    mistral: { type: "api_key", key: "mistral-FAKE-base" },
    "mistral-1-api": { type: "api_key", key: "mistral-FAKE-api" },
    "mistral-api": { type: "api_key", key: "mistral-FAKE-ignored" },
  }));
  const { fetchFn, calls } = routes();
  const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, families: ["mistral"], env: {}, home: directory, stores: [], allowBrowser: false });
  const results = report.byFamily.mistral;
  assert.deepEqual(results.map((result) => [result.slot ?? null, result.account, result.ok]), [[null, "", true], ["1-api", "#1-api", true]]);
  assert.equal(calls.some((call) => String(call.init.headers.Authorization).includes("ignored")), false, "a non-slot suffix is never queried");
  assert.equal(JSON.stringify(report).includes("mistral-FAKE"), false, "no key reaches the report");
});

test("mistral: the compact widget gains a Mistral row only when Mistral is configured", async () => {
  const { renderBoxWidget } = await import("../src/render/panel.js");
  const { plainPalette } = await import("../src/render/theme.js");
  const { fetchFn } = routes();
  const mistral = await fetchQuota(credential(), { now: NOW, fetchFn });
  const claude = { family: "claude", label: "Claude (Pi)", account: "", plan: null, windows: [], error: "no claude credential in the Pi store", ok: false, notConfigured: true, updatedAt: new Date(NOW).toISOString(), source: "fixture" };

  const without = renderBoxWidget([claude], plainPalette(), 0).join("\n");
  assert.doesNotMatch(without, /Mistral/, "no permanent not-configured row for a user without Mistral");

  const withMistral = renderBoxWidget([claude, mistral], plainPalette(), 0).join("\n");
  assert.match(withMistral, /Mistral:.*81%/, "the row shows the Vibe budget");
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
  assert.deepEqual(record.accounts.map((account) => account.id), ["", "#1-api"]);
  for (const account of record.accounts) {
    for (const limit of account.limits) assert.ok(limit.percent >= 0 && limit.percent <= 1, JSON.stringify(limit));
  }
});
