import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectLocalStatsInWorker } from "../src/local/worker.js";

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
});
