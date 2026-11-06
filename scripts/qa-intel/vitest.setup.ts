import { expect, vi } from "vitest";

/**
 * Per-suite timeout for the qa-intel engine and contract-auditor tests. Each file builds ts-morph projects, so under
 * parallel load a test can pass the 5000ms default. Scoped by test path: other suites keep the global default.
 */
export const QA_INTEL_TEST_TIMEOUT_MS = 30_000;

const testPath = (expect.getState().testPath ?? "").replace(/\\/g, "/");
if (/\/scripts\/(qa-intel|contract-auditor)\//.test(testPath)) {
  vi.setConfig({ testTimeout: QA_INTEL_TEST_TIMEOUT_MS });
}
