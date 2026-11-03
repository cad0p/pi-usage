import { parentPort, workerData } from "node:worker_threads";

import { LocalScanAbortedError, collectLocalStats } from "./pi-sessions.js";

const options = workerData?.options ?? {};
// A stop request is a flag the scan polls, not a message it has to be idle to
// receive: a cold scan spends its time inside synchronous reads and hashing.
const stopFlag = workerData?.stopFlag instanceof Int32Array ? workerData.stopFlag : null;

try {
  const result = await collectLocalStats({
    ...options,
    shouldStop: () => stopFlag !== null && Atomics.load(stopFlag, 0) === 1,
    // The host keeps this handle: if it has to kill this thread, it can release
    // the lock, and only with the token this scan created.
    onLock: (lock) => parentPort?.postMessage({ type: "lock", path: lock.path, token: lock.token }),
  });
  parentPort?.postMessage({ type: "result", ok: true, result });
} catch (error) {
  // Do not serialize arbitrary error objects from the scanner into the host.
  parentPort?.postMessage({
    type: "result",
    ok: false,
    aborted: error instanceof LocalScanAbortedError,
    error: "the scan failed",
  });
}
