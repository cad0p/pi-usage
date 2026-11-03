/**
 * The worker lifecycle.
 *
 * A cold scan runs for seconds, and the session that asked for it can end in
 * the middle. These tests pin the two halves of that: the worker stops when it
 * is told to (or is killed when it does not), and either way the history lock
 * is released — only by the run that owns it.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectLocalStatsInWorker, startLocalStatsWorker } from "../src/local/worker.js";

/**
 * A throwaway session store: enough files that a scan is still running when the
 * stop arrives, small enough to write in milliseconds.
 */
function sessionTree(files = 400) {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-local-worker-store-"));
  const sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  const line = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-fixture",
      usage: { input: 12, output: 7, cacheRead: 3, cacheWrite: 1 },
    },
  });
  const body = Array.from({ length: 20 }, () => line).join("\n") + "\n";
  for (let index = 0; index < files; index += 1) {
    writeFileSync(join(sessions, `session-${String(index).padStart(4, "0")}.jsonl`), body, "utf-8");
  }
  return { dir, sessions, cachePath: join(dir, "cache", "local-sessions.json"), historyDir: join(dir, "history") };
}

/** Wait for the scan to hold the lock, so a stop lands while the scan is running. */
async function waitForLock(lockPath) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(lockPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

test("local token statistics run through the Node worker entry point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-local-worker-"));
  const result = await collectLocalStatsInWorker({
    roots: [],
    cachePath: join(dir, "scan.json"),
    historyDir: join(dir, "history"),
    env: {},
    now: Date.now(),
    budgetMs: 1_000,
  });

  assert.deepEqual(result.byFamily, {});
  assert.equal(result.scan.files, 0);
  assert.equal(result.scan.partial, false);
  assert.equal(result.scan.locked, false);
  assert.equal(existsSync(join(dir, "scan.json.lock")), false, "a finished scan releases its lock");
});

test("a scan stopped mid-run ends as aborted, releases its lock and writes nothing", async () => {
  const store = sessionTree();
  const lockPath = `${store.cachePath}.lock`;
  const scan = startLocalStatsWorker({
    roots: [store.sessions],
    cachePath: store.cachePath,
    historyDir: store.historyDir,
    env: {},
    now: Date.now(),
    budgetMs: 60_000,
  });

  assert.equal(await waitForLock(lockPath), true, "the scan really took the lock before the stop");
  await scan.stop();

  await assert.rejects(scan.result, (error) => {
    assert.equal(error.name, "AbortError", "a stop is not a failure");
    return true;
  });
  assert.equal(existsSync(lockPath), false, "a stopped scan leaves no lock for the next run to trip over");
  assert.equal(existsSync(store.cachePath), false, "a stopped scan writes no partial cache");
  assert.deepEqual(
    existsSync(join(store.dir, "cache")) ? readdirSync(join(store.dir, "cache")) : [],
    [],
    "and leaves no temporary file behind",
  );
});

test("stopping twice is harmless and a finished scan stops cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-local-worker-done-"));
  const scan = startLocalStatsWorker({
    roots: [],
    cachePath: join(dir, "scan.json"),
    historyDir: join(dir, "history"),
    env: {},
    now: Date.now(),
    budgetMs: 1_000,
  });
  const result = await scan.result;
  assert.equal(result.scan.files, 0);
  await scan.stop();
  await scan.stop();
  assert.equal(existsSync(join(dir, "scan.json.lock")), false);
});

/** A worker that never reports and never exits: the thread that has to be killed. */
function wedgedWorker() {
  const worker = new EventEmitter();
  worker.postMessage = () => {};
  worker.terminate = async () => {
    worker.terminated = true;
    setImmediate(() => worker.emit("exit", 1));
    return 1;
  };
  return worker;
}

test("a worker that will not stop is terminated and its own lock is released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-local-worker-wedged-"));
  const lockPath = join(dir, "scan.json.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath, "1234-fixture-token\n", "utf-8");
  const worker = wedgedWorker();

  const scan = startLocalStatsWorker({}, { graceMs: 10, spawn: () => worker });
  worker.emit("message", { type: "lock", path: lockPath, token: "1234-fixture-token" });
  await scan.stop();

  assert.equal(worker.terminated, true, "the grace period ends in a terminate, not a hang");
  await assert.rejects(scan.result, (error) => error.name === "AbortError");
  assert.equal(existsSync(lockPath), false, "the parent releases the lock the killed thread could not");
});

test("a lock another run took over is never removed by the terminating parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-local-worker-foreign-"));
  const lockPath = join(dir, "scan.json.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath, "9876-successor-token\n", "utf-8");
  const worker = wedgedWorker();

  const scan = startLocalStatsWorker({}, { graceMs: 10, spawn: () => worker });
  // Our run lost the lock (a stale takeover): the file now carries the successor's token.
  worker.emit("message", { type: "lock", path: lockPath, token: "1234-abandoned-token" });
  await scan.stop();

  await assert.rejects(scan.result, (error) => error.name === "AbortError");
  assert.equal(existsSync(lockPath), true, "the successor's lock survives someone else's shutdown");
});
