import { parentPort, workerData } from "node:worker_threads";

import { collectLocalStats } from "./pi-sessions.js";

try {
  const result = await collectLocalStats(workerData?.options ?? {});
  parentPort?.postMessage({ ok: true, result });
} catch {
  // Do not serialize arbitrary error objects from the scanner into the host.
  parentPort?.postMessage({ ok: false, error: "local token stats scan failed" });
}
