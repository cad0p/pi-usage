/**
 * Run the potentially large local session scan away from Pi's TUI event loop.
 * The worker runs the plain Node ESM entry point; the extension itself may be
 * loaded through jiti, but this worker never needs that loader.
 */

import { Worker } from "node:worker_threads";

/**
 * @param {import("./pi-sessions.js").LocalStatsOptions} [options]
 * @returns {Promise<Awaited<ReturnType<typeof import("./pi-sessions.js").collectLocalStats>>>}
 */
export function collectLocalStatsInWorker(options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./stats-worker.js", import.meta.url), {
      workerData: { options },
    });
    worker.once("message", (message) => {
      if (settled) return;
      settled = true;
      if (message?.ok) resolve(message.result);
      else reject(new Error("local token stats scan failed"));
    });
    worker.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error("local token stats worker failed"));
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(code === 0 ? "local token stats worker returned no result" : "local token stats worker failed"));
    });
  });
}
