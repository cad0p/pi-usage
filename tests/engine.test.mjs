/**
 * Engine, cache and Moshi-artifact tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectFamily, collectQuota } from "../src/engine.js";
import { buildRecords } from "../src/omarchy/record.js";
import { clearCache, readCache, withCache, writeCache } from "../src/cache.js";
import {
  antigravityUsageBody,
  claudeUsageBody,
  codexUsageBody,
  githubActionsSummaryBody,
  githubActionsUsageBody,
  jsonResponse,
  routedFetch,
} from "./helpers.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-auth.json", import.meta.url));
const NOW = 1_800_000_000_000;

function fullRoutes() {
  return routedFetch([
    ["api.anthropic.com", () => jsonResponse(claudeUsageBody())],
    ["chatgpt.com", () => jsonResponse(codexUsageBody())],
    ["cloudcode", () => jsonResponse(antigravityUsageBody())],
    ["zen/go/v1/usage", () => jsonResponse({}, { status: 404 })],
    ["opencode.ai/zen", () => jsonResponse({ object: "list", data: [{ id: "m1" }, { id: "m2" }] })],
  ]);
}

test("collectQuota reports all six registered families when GitHub Actions is enabled", async () => {
  const { fetchFn } = fullRoutes();
  const runCommand = (_command, args) => {
    const path = args.at(-1);
    const body = path.startsWith("/orgs/")
      ? { login: "KoralisSoft", plan: { name: "free" } }
      : path.includes("/usage/summary")
        ? githubActionsSummaryBody()
        : githubActionsUsageBody();
    return { status: 0, stdout: JSON.stringify(body), stderr: "", error: null };
  };
  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    runCommand,
    env: { PI_QUOTA_GITHUB_ACTIONS: "1", PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000" },
    stores: [],
    allowBrowser: false,
  });

  assert.deepEqual(Object.keys(report.byFamily).sort(), ["antigravity", "claude", "codex", "github-actions", "mistral", "opencode-go"]);
  assert.equal(report.readOnly, true);
  assert.equal(report.schemaVersion, 1);

  const byFamily = Object.fromEntries(report.providers.map((provider) => [provider.family, provider]));
  assert.equal(byFamily.claude.ok, true);
  assert.equal(byFamily.codex.ok, true);
  assert.equal(byFamily.codex.plan, "plus");
  assert.equal(byFamily.antigravity.ok, true);
  assert.equal(byFamily["opencode-go"].ok, false);
  assert.match(byFamily["opencode-go"].error ?? "", /piquota auth opencode/);
  assert.equal(byFamily["github-actions"].ok, true);
});

test("host-resolved OAuth credentials override access and Codex identity only in memory", async () => {
  const routes = fullRoutes().fetchFn;
  const codexToken = [
    "header",
    Buffer.from(JSON.stringify({ exp: NOW / 1000 + 600 })).toString("base64url"),
    "signature",
  ].join(".");
  let sentAuthorization = null;
  let sentAccountId = null;
  const fetchFn = async (input, init) => {
    if (String(input).includes("chatgpt.com")) {
      sentAuthorization = init.headers.Authorization;
      sentAccountId = init.headers["chatgpt-account-id"];
    }
    return routes(input, init);
  };
  const report = await collectFamily("codex", {
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    env: {},
    stores: [],
    allowBrowser: false,
    localStats: false,
    authOverrides: {
      "openai-codex": { access: codexToken, expiresAtMs: NOW + 600_000, accountId: "acct-from-pi" },
    },
  });

  assert.equal(sentAuthorization, `Bearer ${codexToken}`);
  assert.equal(sentAccountId, "acct-from-pi");
  assert.equal(report.byFamily.codex[0].account, "acct-fro…", "the display identity is shortened; the full account id was sent in the request header");
  assert.equal(JSON.stringify(report).includes(codexToken), false, "the report never carries a resolved auth token");
});

test("Pi OAuth overrides supply credentials when the standalone reader has no matching store entry", async () => {
  const routes = fullRoutes().fetchFn;
  let sentAuthorization = null;
  const fetchFn = async (input, init) => {
    if (String(input).includes("chatgpt.com")) sentAuthorization = init.headers.Authorization;
    return routes(input, init);
  };
  const token = [
    "header",
    Buffer.from(JSON.stringify({
      exp: NOW / 1000 + 600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-runtime" },
    })).toString("base64url"),
    "signature",
  ].join(".");
  const report = await collectFamily("codex", {
    paths: [],
    now: NOW,
    fetchFn,
    env: {},
    stores: [],
    allowBrowser: false,
    localStats: false,
    authOverrides: { "openai-codex": { access: token, expiresAtMs: NOW + 600_000 } },
  });

  assert.equal(sentAuthorization, `Bearer ${token}`);
  assert.equal(report.byFamily.codex[0].account, "acct-run…");
  assert.equal(report.byFamily.codex[0].source, "Pi runtime auth");
  assert.equal(JSON.stringify(report).includes(token), false, "the synthesized credential is in-memory only");
});

test("collectQuota emits one-family fragments before slower families finish", async () => {
  const routes = fullRoutes().fetchFn;
  let releaseCodex;
  const codexGate = new Promise((resolve) => { releaseCodex = resolve; });
  const fetchFn = async (input, init) => {
    if (String(input).includes("chatgpt.com")) await codexGate;
    return routes(input, init);
  };
  let resolveFirst;
  const firstFamily = new Promise((resolve) => { resolveFirst = resolve; });
  const emitted = [];
  const pending = collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["claude", "codex"],
    env: {},
    stores: [],
    allowBrowser: false,
    localStats: false,
    onFamily: async (family, fragment) => {
      emitted.push(family);
      assert.deepEqual(new Set(fragment.providers.map((provider) => provider.family)), new Set([family]));
      if (family === "claude") resolveFirst(family);
    },
  });

  assert.equal(await Promise.race([firstFamily, new Promise((resolve) => setTimeout(() => resolve("timeout"), 250))]), "claude");
  assert.deepEqual(emitted, ["claude"], "the Claude fragment arrives while Codex is still blocked");
  releaseCodex();
  const final = await pending;
  assert.deepEqual(emitted, ["claude", "codex"]);
  assert.equal(final.providers.length, 2);
});

test("collectQuota marks a family with no credential as degraded, not missing", async () => {
  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, families: ["claude", "grok"], env: {}, stores: [], allowBrowser: false });
  assert.equal(report.providers.length, 2);
  const grok = report.providers.find((provider) => provider.family === "grok");
  assert.ok(grok);
  assert.equal(grok.ok, false);
  assert.match(grok.error ?? "", /no grok credential/);
});

test("collectQuota provides actionable diagnosis when Pi store has openai API instead of openai-codex", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-openai-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    openai: { type: "oauth", access: "fake-access" }
  }));

  const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, families: ["codex"], env: {}, stores: [], allowBrowser: false });
  assert.equal(report.providers.length, 1);
  assert.equal(report.providers[0].family, "codex");
  assert.equal(report.providers[0].notConfigured, true);
  assert.match(report.providers[0].error ?? "", /found 'openai' API; run \/login openai-codex in Pi/);
});

test("a crashing provider degrades instead of taking the report down", async () => {
  const fetchFn = /** @type {typeof fetch} */ (async () => {
    throw new Error("socket exploded");
  });
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, families: ["codex"], env: {}, stores: [], allowBrowser: false });
  assert.equal(report.providers.length, 1);
  assert.equal(report.providers[0].ok, false);
});

test("the normalized report never contains token material", async () => {
  const { fetchFn } = fullRoutes();
  const githubSecret = "ghp_FAKE_ENGINE_GITHUB_TOKEN_0123456789";
  const runCommand = (_command, args) => {
    const path = args.at(-1);
    const body = path.includes("/usage/summary")
      ? { ...githubActionsSummaryBody(), debugToken: githubSecret }
      : githubActionsUsageBody([
          { product: "actions", sku: "actions_linux", quantity: 52, unitType: "minutes", repositoryName: githubSecret },
        ]);
    return { status: 0, stdout: JSON.stringify(body), stderr: "", error: null };
  };
  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    runCommand,
    env: {
      PI_QUOTA_GITHUB_ACTIONS: "on",
      PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000",
      GITHUB_TOKEN: githubSecret,
    },
    stores: [],
    allowBrowser: false,
  });
  const serialized = JSON.stringify(report);
  for (const secret of ["sk-ant-oat01", "ya29.", "1//FAKE", "rt.1.FAKE", "sk-FAKE-zen", "fixture-signature", githubSecret]) {
    assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  }
});

test("cache round-trips, respects the TTL and stores no secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });

  assert.equal(writeCache(report, { path, now: NOW }).ok, true);
  const hit = readCache({ path, now: NOW + 1000, ttlMs: 60_000 });
  assert.ok(hit);
  assert.equal(hit.report.providers.length, report.providers.length);

  assert.equal(readCache({ path, now: NOW + 61_000, ttlMs: 60_000 }), null);

  const raw = readFileSync(path, "utf-8");
  assert.equal(raw.includes("sk-ant-oat01"), false);
  assert.equal(raw.includes("fixture-signature"), false);
  assert.equal(clearCache({ path }).removed, true);
  assert.equal(readCache({ path }), null);
});

test("the cache judges each family by its own fetch time", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-clocks-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });

  // The Pi extension writes the report family by family: Claude was fetched
  // 200 s before the rest, and the file itself was written a moment ago.
  assert.equal(
    writeCache(report, {
      path,
      now: NOW,
      fetchedAtMs: { claude: NOW - 200_000, codex: NOW, antigravity: NOW, "opencode-go": NOW },
    }).ok,
    true,
  );
  const hit = readCache({ path, now: NOW + 5_000, ttlMs: Number.POSITIVE_INFINITY });
  assert.ok(hit);
  assert.equal(hit.fetchedAt.claude, NOW - 200_000, "a family's own clock is kept");
  assert.equal(hit.ageMs, 205_000, "the report is as old as its oldest family");
  assert.equal(readCache({ path, now: NOW + 5_000, ttlMs: 60_000 }), null, "and one stale family expires the whole-file read");

  let loads = 0;
  const loader = async () => {
    loads += 1;
    return report;
  };
  const codex = await withCache({ path, now: NOW + 5_000, ttlMs: 60_000, families: ["codex"] }, loader);
  assert.equal(codex.cached, true, "a family inside its own TTL is served");
  assert.equal(loads, 0);

  const claude = await withCache({ path, now: NOW + 5_000, ttlMs: 60_000, families: ["claude"] }, loader);
  assert.equal(claude.cached, false, "Claude's 200 s old copy is not a 60 s answer, however new the file is");
  assert.equal(loads, 1);
});

test("a write that did not fetch a family never restamps that family to now", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-fresh-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  const HOUR = 3_600_000;
  // Claude's results are an hour old and no clock names it (a deleted
  // refresh-state, a mixed cache): the extension just fetched Codex and saves
  // its whole in-memory report.
  const aged = {
    ...report,
    providers: report.providers.map((provider) =>
      provider.family === "claude" ? { ...provider, updatedAt: new Date(NOW - HOUR).toISOString() } : provider,
    ),
  };
  assert.equal(writeCache(aged, { path, now: NOW, fetchedAtMs: { codex: NOW }, freshFamilies: ["codex"] }).ok, true);
  const hit = readCache({ path, now: NOW, ttlMs: Number.POSITIVE_INFINITY });
  assert.ok(hit);
  assert.equal(hit.fetchedAt.codex, NOW);
  assert.equal(hit.fetchedAt.claude, NOW - HOUR, "Claude is as old as its own results, not as new as the write");

  // A second write keeps that clock instead of taking the newer one.
  assert.equal(writeCache(aged, { path, now: NOW + 10_000, freshFamilies: ["codex"] }).ok, true);
  assert.equal(readCache({ path, now: NOW + 10_000, ttlMs: Number.POSITIVE_INFINITY }).fetchedAt.claude, NOW - HOUR);

  let loads = 0;
  const claude = await withCache({ path, now: NOW + 10_000, ttlMs: 60_000, families: ["claude"] }, async () => {
    loads += 1;
    return report;
  });
  assert.equal(claude.cached, false, "the CLI does not serve the hour-old Claude copy as fresh");
  assert.equal(loads, 1);
});

test("a cache written before per-family clocks is still aged by its savedAt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-legacy-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });

  writeFileSync(path, JSON.stringify({ savedAt: NOW, report }, null, 2), "utf-8");
  const hit = readCache({ path, now: NOW + 5_000, ttlMs: 60_000 });
  assert.ok(hit, "an old file is still readable");
  assert.equal(hit.fetchedAt.claude, NOW, "every family falls back to savedAt");
  assert.equal(hit.fetchedAt["opencode-go"], NOW);
  assert.equal(readCache({ path, now: NOW + 61_000, ttlMs: 60_000 }), null, "and it still expires as a whole");
});

test("withCache refreshes once and then serves the cached copy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  };

  const first = await withCache({ path, now: NOW, ttlMs: 60_000 }, loader);
  assert.equal(first.cached, false);
  const second = await withCache({ path, now: NOW + 5000, ttlMs: 60_000 }, loader);
  assert.equal(second.cached, true);
  assert.equal(loads, 1);
  const third = await withCache({ path, now: NOW + 5000, ttlMs: 60_000, force: true }, loader);
  assert.equal(third.cached, false);
  assert.equal(loads, 2);
});

test("withCache treats a report saved under another key as a miss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-key-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  };

  await withCache({ path, now: NOW, ttlMs: 60_000, key: "claude-source:auto" }, loader);
  const sameKey = await withCache({ path, now: NOW + 5000, ttlMs: 60_000, key: "claude-source:auto" }, loader);
  assert.equal(sameKey.cached, true);
  const otherKey = await withCache({ path, now: NOW + 5000, ttlMs: 60_000, key: "claude-source:pi" }, loader);
  assert.equal(otherKey.cached, false, "a Claude source switch must refetch");
  assert.equal(loads, 2);
  assert.equal(JSON.parse(readFileSync(path, "utf-8")).key, "claude-source:pi");
  const partial = await withCache({ path, now: NOW + 6000, ttlMs: 60_000, key: "claude-source:auto", families: ["codex"] }, loader);
  assert.equal(partial.cached, false);
  assert.equal(JSON.parse(readFileSync(path, "utf-8")).key, "claude-source:auto", "a partial write under a new key replaces, never merges");
});

test("withCache merges a partial family query without poisoning the full cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-partial-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();

  const fullReport = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  writeCache(fullReport, { path, now: NOW });
  assert.equal(readCache({ path, now: NOW }).report.providers.length, 5);

  const partial = await withCache(
    { path, now: NOW + 1000, ttlMs: 60_000, families: ["codex"] },
    async () => collectQuota({ paths: [FIXTURE], claudeCodePaths: [], families: ["codex"], now: NOW + 1000, fetchFn, env: {}, stores: [], allowBrowser: false }),
  );
  assert.deepEqual(partial.report.providers.map((p) => p.family), ["codex"]);

  const cachedFull = readCache({ path, now: NOW + 1000 });
  assert.equal(cachedFull.report.providers.length, 5);
  assert.deepEqual(Object.keys(cachedFull.report.byFamily).sort(), ["antigravity", "claude", "codex", "mistral", "opencode-go"]);
});

test("the terminal surface also shows last known values while a provider is throttled", async () => {
  const { mergeLastGood } = await import("../src/sticky.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-cli-lastgood-"));
  const NOW = 1_800_000_000_000;

  const healthy = {
    engine: "pi-quota", schemaVersion: 1, readOnly: true, generatedAt: new Date(NOW).toISOString(),
    sources: [], warnings: [],
    providers: [{ family: "claude", label: "Claude (Pi)", account: "fixture@example.com", plan: null,
      windows: [{ id: "5h", label: "5h window", usedPercent: 4, remainingPercent: 96, resetsAt: null,
        resetsInSec: 3600, windowSeconds: null, note: null }],
      error: null, ok: true, updatedAt: new Date(NOW).toISOString(), source: "/tmp/auth.json", expiresInMin: 60 }],
    byFamily: {},
  };
  healthy.byFamily = { claude: healthy.providers };

  mergeLastGood(healthy, { env: {}, home: dir, now: NOW });

  const throttled = {
    ...healthy,
    providers: [{ ...healthy.providers[0], ok: false, windows: [], error: "backing off after a throttle: next attempt in 120s" }],
  };
  throttled.byFamily = { claude: throttled.providers };

  const { report } = mergeLastGood(throttled, { env: {}, home: dir, now: NOW + 60_000 });
  assert.equal(report.providers[0].ok, true, "the terminal must not show n/a while merely throttled");
  assert.equal(report.providers[0].windows[0].remainingPercent, 96);
  assert.match(report.providers[0].note ?? "", /last known values, 1 min old/);
});

test("the Claude Code CLI source wins over Pi's own anthropic entry when both exist", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-claude-code", expiresAt: NOW + 3_600_000, subscriptionType: "max" } }),
  );

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  const claude = report.providers[0];
  assert.equal(claude.ok, true);
  assert.equal(claude.sourceKind, "claude-code");
  assert.equal(claude.plan, "max");
  assert.equal(claude.label, "Claude (Pi)", "the label never reveals which source was used");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-claude-code");
});

test("with no Claude Code store, Pi's own anthropic entry is used", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  const claude = report.providers[0];
  assert.equal(claude.ok, true);
  assert.equal(claude.sourceKind, "pi");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-access-for-fixtures-only");
});

test("auto passes over an expired Claude Code token when Pi's anthropic login is fresh, and says so", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-expired", expiresAt: NOW - 60_000, subscriptionType: "pro" } }),
  );

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  assert.equal(report.providers[0].sourceKind, "pi");
  assert.equal(report.claudeSource.mode, "pi");
  assert.equal(calls.length, 1, "only one Claude source is queried");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-access-for-fixtures-only");
  assert.ok(report.warnings.some((warning) => /claude: the Claude Code token expired 1m ago; using Pi's anthropic login instead/.test(warning)));
});

test("an expired Claude Code token is still used when Pi has no fresh anthropic login", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-expired", expiresAt: NOW - 60_000, subscriptionType: "pro" } }),
  );
  const emptyStore = join(home, "empty-auth.json");
  writeFileSync(emptyStore, "{}");

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({ paths: [emptyStore], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  assert.equal(report.providers[0].sourceKind, "claude-code");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-expired");
  assert.ok(report.warnings.some((warning) => /claude: the Claude Code token expired/.test(warning)));
});

test("PI_QUOTA_CLAUDE_SOURCE=claude-code keeps an expired Claude Code token even when Pi's is fresh", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-expired", expiresAt: NOW - 60_000, subscriptionType: "pro" } }),
  );

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({
    paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: { PI_QUOTA_CLAUDE_SOURCE: "claude-code" }, home, usersRoot, stores: [], allowBrowser: false,
  });

  assert.equal(report.providers[0].sourceKind, "claude-code");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-expired");
});

test("PI_QUOTA_CLAUDE_SOURCE=pi overrides the default preference", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-claude-code", expiresAt: NOW + 3_600_000 } }),
  );

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({
    paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: { PI_QUOTA_CLAUDE_SOURCE: "pi" }, home, usersRoot, stores: [], allowBrowser: false,
  });

  assert.equal(report.providers[0].sourceKind, "pi");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-access-for-fixtures-only");
});

test("PI_QUOTA_CLAUDE_SOURCE=claude-code never falls back to the Pi store", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({
    paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: { PI_QUOTA_CLAUDE_SOURCE: "claude-code" }, home, usersRoot, stores: [], allowBrowser: false,
  });

  assert.equal(report.providers[0].ok, false);
  assert.equal(calls.length, 0, "no request is made when the requested source is missing");
  assert.match(report.providers[0].error, /Claude Code/);
});

test("neither Claude source configured degrades as not-configured, not as a failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  const emptyStore = join(home, "empty-auth.json");
  writeFileSync(emptyStore, "{}");

  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [emptyStore], claudeCodePaths: [], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  const claude = report.providers[0];
  assert.equal(claude.ok, false);
  assert.equal(claude.notConfigured, true);
  assert.match(claude.error, /no claude credential/);
});

test("an Antigravity token renewed in memory never warns that the stored one expired", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-antigravity-renewed-"));
  const store = join(home, "auth.json");
  writeFileSync(
    store,
    JSON.stringify({
      antigravity: {
        type: "oauth",
        access: "ya29.STALE",
        refresh: "1//FAKE-google-refresh-for-fixtures-only",
        projectId: "rising-fixture-project",
        expires: NOW - 271_316 * 60_000,
      },
    }),
  );
  const { fetchFn } = routedFetch([
    ["oauth2.googleapis.com", () => jsonResponse({ access_token: "ya29.RENEWED", expires_in: 3600 })],
    ["cloudcode", () => jsonResponse(antigravityUsageBody())],
  ]);

  const report = await collectQuota({
    paths: [store],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["antigravity"],
    env: { ANTIGRAVITY_CLIENT_ID: "id-fixture", ANTIGRAVITY_CLIENT_SECRET: "secret-fixture" },
    home,
    stores: [],
    allowBrowser: false,
  });

  const provider = report.providers[0];
  assert.equal(provider.ok, true);
  assert.equal(provider.expiresInMin, null, "the run used a token that is not expiring");
  assert.equal(provider.tokenRenewedInMemory, true);
  assert.equal(
    report.warnings.some((warning) => /antigravity: .*expired/.test(warning)),
    false,
    "the stored copy is stale, but this run did not use it",
  );
});

test("a renewed Antigravity token keeps its warning silent even when the quota call failed", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-antigravity-renewed-fail-"));
  const store = join(home, "auth.json");
  writeFileSync(
    store,
    JSON.stringify({
      antigravity: {
        type: "oauth",
        access: "ya29.STALE",
        refresh: "1//FAKE-google-refresh-for-fixtures-only",
        projectId: "rising-fixture-project",
        expires: NOW - 60_000,
      },
    }),
  );
  // The renewal succeeds, so the stored expiry explains nothing; the quota call
  // then fails for a reason of its own, and only that reason belongs on screen.
  const { fetchFn } = routedFetch([
    ["oauth2.googleapis.com", () => jsonResponse({ access_token: "ya29.RENEWED", expires_in: 3600 })],
    ["cloudcode", () => jsonResponse({ error: { code: 500, message: "backend error" } }, { status: 500 })],
  ]);

  const report = await collectQuota({
    paths: [store],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["antigravity"],
    env: { ANTIGRAVITY_CLIENT_ID: "id-fixture", ANTIGRAVITY_CLIENT_SECRET: "secret-fixture" },
    home,
    stores: [],
    allowBrowser: false,
  });

  const provider = report.providers[0];
  assert.equal(provider.ok, false);
  assert.equal(provider.expiresInMin, null);
  assert.equal(provider.tokenRenewedInMemory, true, "the degraded result carries the renewal");
  assert.match(provider.error ?? "", /Antigravity quota request failed/);
  assert.equal(
    report.warnings.some((warning) => /antigravity: .*expired/.test(warning)),
    false,
    "the stored countdown is not the explanation for a failure after a successful renewal",
  );
});

test("an Antigravity token that could not be renewed still warns about the stored expiry", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-antigravity-stale-"));
  const store = join(home, "auth.json");
  writeFileSync(
    store,
    JSON.stringify({
      antigravity: {
        type: "oauth",
        access: "ya29.STALE",
        refresh: "1//FAKE-google-refresh-for-fixtures-only",
        projectId: "rising-fixture-project",
        expires: NOW - 60_000,
      },
    }),
  );
  const { fetchFn } = routedFetch([
    ["oauth2.googleapis.com", () => jsonResponse({ error: "invalid_grant" }, { status: 400 })],
    ["cloudcode", () => jsonResponse({ error: { code: 401, message: "invalid credentials" } }, { status: 401 })],
  ]);

  const report = await collectQuota({
    paths: [store],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["antigravity"],
    env: { ANTIGRAVITY_CLIENT_ID: "id-fixture", ANTIGRAVITY_CLIENT_SECRET: "secret-fixture" },
    home,
    stores: [],
    allowBrowser: false,
  });

  const provider = report.providers[0];
  assert.equal(provider.ok, false);
  assert.equal(provider.expiresInMin, -1, "nothing was renewed: the stored expiry is the truth");
  assert.ok(
    report.warnings.some((warning) => /antigravity: the Pi token expired 1m ago; use that provider in Pi to refresh it/.test(warning)),
    "the warning must survive a failed renewal",
  );
});

test("warnings from parallel provider fetches are deterministically ordered by families", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-warn-order-"));
  const fetchFn = /** @type {typeof fetch} */ (async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("anthropic")) {
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse({}, { status: 429, headers: { "retry-after": "60" } });
    }
    if (urlStr.includes("chatgpt")) {
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({}, { status: 429, headers: { "retry-after": "60" } });
    }
    return jsonResponse({});
  });

  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["claude", "codex"],
    env: {},
    home,
    stores: [],
    allowBrowser: false,
  });

  const throttledWarnings = report.warnings.filter((w) => w.includes("throttled upstream"));
  assert.equal(throttledWarnings.length, 2);
  assert.ok(throttledWarnings[0].startsWith("claude:"));
  assert.ok(throttledWarnings[1].startsWith("codex:"));
});


test("accounts of one family are fetched in parallel, bounded, in credential order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-parallel-"));
  const authPath = join(directory, "auth.json");
  const store = { "opencode-go": { type: "api_key", key: "oc-base" } };
  for (let slot = 2; slot <= 12; slot += 1) store[`opencode-go-${slot}`] = { type: "api_key", key: `oc-${slot}` };
  writeFileSync(authPath, JSON.stringify(store));

  const run = async (env) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchFn = async (url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later keys answer first, so a sequential or order-dependent merge would show.
      const key = String(init?.headers?.Authorization ?? "").replace("Bearer oc-", "");
      await new Promise((resolve) => setTimeout(resolve, key === "base" ? 30 : 30 - Number(key)));
      inFlight -= 1;
      if (!String(url).includes("zen/go/v1/usage")) return jsonResponse({ error: "no route" }, { status: 404 });
      const percent = key === "base" ? 1 : Number(key);
      const window = { status: "ok", percent, resetsAt: "2027-01-01T00:00:00.000Z" };
      return jsonResponse({ usage: { rolling: window, weekly: window, monthly: window } });
    };
    const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, families: ["opencode-go"], env, home: directory, stores: [], allowBrowser: false });
    return { report, maxInFlight };
  };

  const parallel = await run({});
  assert.equal(parallel.maxInFlight, 8, "default concurrency is 8 accounts at a time");
  const results = parallel.report.byFamily["opencode-go"];
  assert.equal(results.length, 12);
  assert.deepEqual(results.map((result) => result.slot ?? null), [null, "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.ok(results.every((result) => result.ok));

  const sequential = await run({ PI_QUOTA_ACCOUNT_CONCURRENCY: "1" });
  assert.equal(sequential.maxInFlight, 1);
  assert.deepEqual(
    sequential.report.byFamily["opencode-go"].map((result) => result.windows.map((window) => window.usedPercent)),
    results.map((result) => result.windows.map((window) => window.usedPercent)),
  );
});

test("mapBounded keeps input order and never exceeds its limit", async () => {
  const { mapBounded, accountConcurrency } = await import("../src/engine.js");
  let inFlight = 0;
  let max = 0;
  const out = await mapBounded([5, 1, 4, 2, 3], 2, async (value, index) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((resolve) => setTimeout(resolve, value));
    inFlight -= 1;
    return `${index}:${value}`;
  });
  assert.deepEqual(out, ["0:5", "1:1", "2:4", "3:2", "4:3"]);
  assert.equal(max, 2);
  assert.deepEqual(await mapBounded([], 4, async () => 1), []);
  assert.equal(accountConcurrency({}), 8);
  assert.equal(accountConcurrency({ PI_QUOTA_ACCOUNT_CONCURRENCY: "0" }), 8);
  assert.equal(accountConcurrency({ PI_QUOTA_ACCOUNT_CONCURRENCY: "3" }), 3);
  assert.equal(accountConcurrency({ PI_QUOTA_ACCOUNT_CONCURRENCY: "99" }), 32);
});

test("mapBounded treats a non-numeric limit as 1 instead of returning holes", async () => {
  const { mapBounded } = await import("../src/engine.js");
  assert.deepEqual(await mapBounded([1, 2, 3], Number.NaN, async (value) => value * 2), [2, 4, 6]);
  assert.deepEqual(await mapBounded([1, 2], undefined, async (value) => value), [1, 2]);
});

test("every request carries the package User-Agent unless the provider sets its own", async () => {
  const { requestJson, PACKAGE_USER_AGENT, withUserAgent } = await import("../src/http.js");
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
  assert.equal(PACKAGE_USER_AGENT, `pi-usage/${version} (+https://github.com/cad0p/pi-usage)`);
  assert.doesNotMatch(PACKAGE_USER_AGENT, /^node/i);

  const seen = [];
  const fetchFn = async (_url, init) => {
    seen.push(init.headers);
    return jsonResponse({ ok: true });
  };
  await requestJson("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: "Bearer x" }, fetchFn });
  await requestJson("https://example.invalid/", { fetchFn });
  await requestJson("https://example.invalid/", { headers: { "user-agent": "antigravity/cli" }, fetchFn });
  assert.equal(seen[0]["User-Agent"], PACKAGE_USER_AGENT);
  assert.equal(seen[0].Authorization, "Bearer x");
  assert.equal(seen[1]["User-Agent"], PACKAGE_USER_AGENT);
  assert.equal(seen[2]["user-agent"], "antigravity/cli");
  assert.equal(seen[2]["User-Agent"], undefined, "a provider's own agent is never duplicated");

  const original = { Accept: "application/json" };
  withUserAgent(original);
  assert.deepEqual(original, { Accept: "application/json" }, "the caller's headers object is not mutated");
});

test("a Claude api_key sibling answers beside the OAuth base, and the record labels both by slot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-claude-api-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    anthropic: { type: "oauth", access: "sk-ant-oat01-FAKE" },
    "anthropic-1-api": { type: "api_key", key: "sk-ant-FAKE-api" },
  }));
  const { fetchFn, calls } = routedFetch([["api.anthropic.com", () => jsonResponse(claudeUsageBody())]]);
  const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, families: ["claude"], env: {}, home: directory, stores: [], allowBrowser: false });

  const results = report.byFamily.claude;
  assert.equal(results.length, 2);
  const api = results.find((result) => result.slot === "1-api");
  assert.equal(api.ok, true);
  assert.deepEqual(api.windows, []);
  assert.match(api.note ?? "", /API key · pay-as-you-go/);
  assert.equal(calls.length, 1, "only the OAuth account reaches Anthropic");
  assert.equal(JSON.stringify(report).includes("sk-ant-FAKE-api"), false, "the key never reaches the report");

  const { record } = buildRecords(report, { now: NOW })[0];
  assert.deepEqual(record.accounts.map((account) => account.id), ["#1", "#1-api"]);
  assert.equal(record.tierLabel, "2 of 2 accounts");
  assert.equal(record.usageStatusText, "", "the api key is not an unavailable account");
  assert.equal(record.authHelpText, "");
  const apiRow = record.accounts.find((account) => account.id === "#1-api");
  assert.equal(apiRow.ok, true);
  assert.equal(apiRow.status, api.note, "a windowless answered account says why it is empty");
});

test("the OpenCode Go usage request is sent with the package User-Agent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-ua-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: "oc-base" } }));
  const agents = [];
  const fetchFn = async (url, init) => {
    if (String(url).includes("zen/go/v1/usage")) agents.push(init.headers["User-Agent"]);
    const window = { status: "ok", percent: 1, resetsAt: "2027-01-01T00:00:00.000Z" };
    return jsonResponse({ usage: { rolling: window, weekly: window, monthly: window } });
  };
  await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, families: ["opencode-go"], env: {}, home: directory, stores: [], allowBrowser: false });
  assert.equal(agents.length, 1);
  assert.match(agents[0], /^pi-usage\/\d+\.\d+\.\d+/);
});
