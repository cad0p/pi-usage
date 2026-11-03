import quotaPanelExtension from "../extensions/quota-panel.ts";

/** Test-only dependency injection; production Pi loads the real extension directly. */
export default function testQuotaPanelExtension(pi) {
  return quotaPanelExtension(pi, pi.__piUsageTestDependencies ?? {});
}
