/**
 * auth.json parsing tests. All fixtures contain plainly fake tokens.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkFreshness,
  loadPiCredentials,
  normalizeCredential,
  readAuthStore,
  resolveAuthPaths,
} from "../src/auth/pi-auth.js";
import { extractChatGptAccountId, extractChatGptPlanType, extractEmail, decodeJwtPayload } from "../src/auth/jwt.js";
import { makeFakeJwt } from "./helpers.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-auth.json", import.meta.url));

test("readAuthStore normalizes all four Pi providers", () => {
  const { credentials, warnings } = readAuthStore(FIXTURE);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    credentials.map((credential) => credential.family).sort(),
    ["antigravity", "claude", "codex", "opencode-go"],
  );

  const byFamily = Object.fromEntries(credentials.map((credential) => [credential.family, credential]));
  assert.equal(byFamily.codex.kind, "oauth");
  assert.equal(byFamily.codex.accountId, "acct_fixture");
  assert.equal(byFamily.codex.label, "Codex (Pi)");
  assert.equal(byFamily.claude.access.startsWith("sk-ant-oat"), true);
  assert.equal(byFamily.antigravity.projectId, "fixture-project");
  assert.equal(byFamily["opencode-go"].kind, "api_key");
  assert.equal(byFamily["opencode-go"].label, "OpenCode Go (Pi)");
});

test("stored credentials never carry an unknown provider", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-auth-"));
  const path = join(directory, "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      "some-other-provider": { type: "oauth", access: "not-ours" },
      anthropic: { type: "oauth", access: "sk-ant-oat01-fake", refresh: "sk-ant-ort01-fake" },
    }),
  );
  const { credentials } = readAuthStore(path);
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].family, "claude");
});

test("numbered sibling providers map onto their base family and slot", () => {
  const base = normalizeCredential("opencode-go", { type: "api_key", key: "sk-fake-base" }, "/tmp/auth.json");
  const sibling = normalizeCredential("opencode-go-2", { type: "api_key", key: "sk-fake-two" }, "/tmp/auth.json");
  const codex = normalizeCredential("openai-codex-3", { type: "api_key", key: "sk-fake-three" }, "/tmp/auth.json");
  assert.ok(base && sibling && codex);
  assert.equal(base.slot, null);
  assert.equal(sibling.slot, "2");
  assert.equal(sibling.provider, "opencode-go-2");
  assert.equal(sibling.family, "opencode-go");
  assert.equal(sibling.label, "OpenCode Go (Pi)");
  assert.equal(codex.slot, "3");
  assert.equal(codex.family, "codex");

  // A non-numeric suffix is a different provider, not a sibling slot, and a
  // sibling of an unknown base is ignored instead of guessed at.
  assert.equal(normalizeCredential("opencode-go-main", { type: "api_key", key: "sk-fake-main" }, "/tmp/auth.json"), null);
  assert.equal(normalizeCredential("opencode-2-work", { type: "api_key", key: "sk-fake-mid" }, "/tmp/auth.json"), null);
});

test("siblings are ordered numerically and de-duplicated by base provider and secret", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-slots-"));
  const path = join(directory, "auth.json");
  /** @param {number} n */
  const entry = (n) => ({ type: "api_key", key: `sk-fake-slot-${n}` });
  writeFileSync(
    path,
    JSON.stringify({
      "opencode-go-11": entry(11),
      "opencode-go-2": entry(2),
      "opencode-go": entry(1),
      "opencode-go-10": entry(10),
      "opencode-go-main": entry(99),
      // Same secret as the base entry: identical secrets collapse even though the
      // slot ids differ.
      "opencode-go-3": entry(1),
    }),
  );

  // loadPiCredentials is what sorts and de-duplicates; readAuthStore keeps file order.
  const { credentials } = loadPiCredentials({ paths: [path] });
  assert.deepEqual(credentials.map((credential) => credential.slot), [null, "2", "10", "11"]);
  assert.deepEqual(credentials.map((credential) => credential.family), ["opencode-go", "opencode-go", "opencode-go", "opencode-go"]);
});

test("an unreadable or corrupt store degrades with a warning instead of throwing", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-auth-"));
  const broken = join(directory, "auth.json");
  writeFileSync(broken, "{ not json");
  const result = readAuthStore(broken);
  assert.deepEqual(result.credentials, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /invalid JSON/);

  const missing = readAuthStore(join(directory, "nope.json"));
  assert.equal(missing.warnings.length, 1);
});

test("Codex identity is read from the JWT payload, never verified", () => {
  const access = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_from_jwt", chatgpt_plan_type: "pro" },
    "https://api.openai.com/profile": { email: "fixture@example.com" },
    exp: 1_893_456_000,
  });
  assert.equal(extractChatGptAccountId(access), "acct_from_jwt");
  assert.equal(extractChatGptPlanType(access), "pro");
  assert.equal(extractEmail(access), "fixture@example.com");
  assert.equal(decodeJwtPayload(access)?.exp, 1_893_456_000);
  assert.equal(decodeJwtPayload("not-a-jwt"), null);

  const credential = normalizeCredential("openai-codex", { type: "oauth", access, refresh: "rt.1.fake" }, "/tmp/auth.json");
  assert.ok(credential);
  assert.equal(credential.accountId, "acct_from_jwt");
  assert.equal(credential.planType, "pro");
  assert.equal(credential.expiresAtMs, 1_893_456_000_000);
});

test("identity never exposes the token and is stable for the same account", () => {
  const access = "sk-ant-oat01-FAKE-fixture-token";
  const first = normalizeCredential("anthropic", { type: "oauth", access }, "/a/auth.json");
  const second = normalizeCredential("anthropic", { type: "oauth", access }, "/b/auth.json");
  assert.ok(first && second);
  assert.equal(first.identity, second.identity);
  assert.equal(first.identity.includes(access), false);
});

test("accounts present in two stores are de-duplicated, not doubled", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-auth-"));
  const linuxHome = join(directory, "linux", ".pi", "agent");
  const windowsHome = join(directory, "windows", ".pi", "agent");
  for (const home of [linuxHome, windowsHome]) {
    writeFileSync(join(mkdirp(home), "auth.json"), JSON.stringify({
      anthropic: { type: "oauth", access: "sk-ant-oat01-FAKE-shared", refresh: "sk-ant-ort01-FAKE-shared" },
    }));
  }

  const result = loadPiCredentials({ paths: [join(linuxHome, "auth.json"), join(windowsHome, "auth.json")] });
  assert.equal(result.credentials.length, 1);
  assert.equal(result.paths.length, 2);
});

test("resolveAuthPaths honours an explicit override and does not scan the Windows drive", () => {
  const paths = resolveAuthPaths({
    env: { PI_AUTH_PATH: "/explicit/auth.json", PI_QUOTA_AUTH_PATH: "/explicit/primary.json" },
    home: "/home/fixture",
    usersRoot: "/mnt/c/Users",
  });
  assert.deepEqual(paths, ["/explicit/primary.json", "/explicit/auth.json"]);
});

test("freshness is derived from the stored expiry and never refreshes", () => {
  const credential = normalizeCredential("anthropic", {
    type: "oauth",
    access: "sk-ant-oat01-fake",
    expires: 1_000_000_000_000,
  }, "/tmp/auth.json");
  assert.ok(credential);
  const expired = checkFreshness(credential, 2_000_000_000_000);
  assert.equal(expired.fresh, false);
  assert.ok((expired.expiresInMin ?? 0) < 0);

  const withoutExpiry = normalizeCredential("opencode-go", { type: "api_key", key: "sk-fake" }, "/tmp/auth.json");
  assert.ok(withoutExpiry);
  assert.equal(checkFreshness(withoutExpiry).fresh, true);
});

/**
 * @param {string} path
 * @returns {string}
 */
function mkdirp(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
