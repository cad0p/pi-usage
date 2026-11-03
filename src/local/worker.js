/**
 * Run the potentially large local session scan away from Pi's TUI event loop.
 * The worker runs the plain Node ESM entry point; the extension itself may be
 * loaded through jiti, but this worker never needs that loader.
 *
 * The scan can outlive the surface that asked for it. A cold scan of a
 * multi-gigabyte session store takes seconds, and the user may `/quit` or
 * `/reload` a second later: a thread left behind keeps reading session files
 * after the session is gone and holds `local-sessions.json.lock` until the
 * 120 s stale timeout, so every later scan is read-only with a warning. The
 * handle owns that lifecycle — the host stops it, and the stop always ends with
 * the lock released and no half-written state.
 */

import { Worker } from "node:worker_threads";

import { releaseHistoryLock } from "./history.js";

/**
 * How long a stopping scan gets to notice the flag and release its own lock
 * before the thread is terminated and the parent releases the lock instead.
 */
export const DEFAULT_STOP_GRACE_MS = 2_000;

/** A scan the host stopped, told apart from a failure by its name. */
function scanStoppedError() {
  const error = new Error("local token stats scan stopped");
  error.name = "AbortError";
  return error;
}

/**
 * Start the scan in a worker thread.
 *
 * The stop request is a shared flag the scan polls rather than a message it has
 * to be idle to receive: a cold scan spends its time inside synchronous reads
 * and hashing, where a queued message would only be seen after the work it is
 * meant to interrupt.
 *
 * @param {import("./pi-sessions.js").LocalStatsOptions} [options]
 * @param {{
 *   graceMs?: number,
 *   spawn?: () => { on: Function, once: Function, postMessage: Function, terminate: () => Promise<number> },
 *   releaseLock?: (lock: { path: string, token: string | null }) => boolean,
 * }} [lifecycle] Test seams: a fake worker and a zero grace period.
 * @returns {{
 *   result: Promise<Awaited<ReturnType<typeof import("./pi-sessions.js").collectLocalStats>>>,
 *   stop: () => Promise<void>,
 * }}
 */
export function startLocalStatsWorker(options = {}, lifecycle = {}) {
  const graceMs = Number.isFinite(lifecycle.graceMs)
    ? Math.max(0, /** @type {number} */ (lifecycle.graceMs))
    : DEFAULT_STOP_GRACE_MS;
  const stopFlag = new Int32Array(new SharedArrayBuffer(4));
  const releaseLock = lifecycle.releaseLock ?? releaseHistoryLock;
  const worker = lifecycle.spawn
    ? lifecycle.spawn()
    : new Worker(new URL("./stats-worker.js", import.meta.url), { workerData: { options, stopFlag } });

  /** The lock the scan told us it holds; only its own token may remove it. */
  /** @type {{ path: string, token: string | null } | null} */
  let lock = null;
  /** @type {{ ok: true, result: any } | { ok: false, aborted: boolean, error: string } | null} */
  let outcome = null;
  let stopping = false;
  let settled = false;
  /** @type {(value: any) => void} */
  let resolveResult = () => {};
  /** @type {(error: Error) => void} */
  let rejectResult = () => {};
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finish = () => {
    if (settled) return;
    settled = true;
    const owned = lock;
    lock = null;
    // A scan that ended on its own already released this in its own `finally`;
    // a thread that had to be killed did not, and its token is the only proof
    // the file is still ours.
    if (owned) releaseLock(owned);
    if (outcome?.ok) resolveResult(outcome.result);
    else rejectResult(outcome?.aborted ? scanStoppedError() : new Error(outcome?.error ?? "the worker thread failed"));
  };

  worker.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "lock") {
      if (typeof message.path === "string") {
        lock = { path: message.path, token: typeof message.token === "string" ? message.token : null };
      }
      return;
    }
    if (message.type !== "result") return;
    outcome = message.ok
      ? { ok: true, result: message.result }
      : {
          ok: false,
          aborted: message.aborted === true,
          error: typeof message.error === "string" ? message.error : "the scan failed",
        };
  });
  worker.once("error", () => {
    // A thread that died (OOM, a broken entry point) never posts a result.
    if (!outcome) outcome = { ok: false, aborted: stopping, error: "the worker thread failed" };
  });
  const exited = new Promise((resolve) => {
    worker.once("exit", (code) => {
      if (!outcome) {
        outcome = stopping
          ? { ok: false, aborted: true, error: "local token stats scan stopped" }
          : { ok: false, aborted: false, error: "the worker thread exited without a result" };
      }
      finish();
      resolve(code);
    });
  });

  /**
   * End the scan: ask it to stop, terminate the thread if it does not, and
   * leave the report cache and the history exactly as they were found.
   */
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    Atomics.store(stopFlag, 0, 1);
    if (!settled) {
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), graceMs);
          timer.unref?.();
        }),
      ]);
      if (!stopped) await worker.terminate().catch(() => 0);
    }
    await exited;
    finish();
  };

  return { result, stop };
}

/**
 * Await one scan to completion. The caller that wants the lifecycle uses
 * {@link startLocalStatsWorker} instead.
 *
 * @param {import("./pi-sessions.js").LocalStatsOptions} [options]
 * @returns {Promise<Awaited<ReturnType<typeof import("./pi-sessions.js").collectLocalStats>>>}
 */
export function collectLocalStatsInWorker(options = {}) {
  return startLocalStatsWorker(options).result;
}
