import { defineConfig } from "vitest/config";

import path from "node:path";

export default defineConfig({
  test: {
    include: [
      "payments/test/**/*.test.ts",
      "web/src/lib/__tests__/**/*.test.ts",
      "web/app/**/__tests__/**/*.test.ts",
      "src/adapters/**/__tests__/**/*.test.ts",
      "src/use_cases/**/__tests__/**/*.test.ts",
      "src/infrastructure/**/__tests__/**/*.test.ts",
      "web/__tests__/**/*.test.ts",
      "scripts/**/__tests__/**/*.test.ts",
    ],
    environment: "node",
    // Raises testTimeout for scripts/qa-intel and scripts/contract-auditor files only (see the file).
    setupFiles: ["scripts/qa-intel/vitest.setup.ts"],
    coverage: {
      // The V8 uncovered-file pass parses every file under the include glob;
      // calibration/fetch-smellycode.sh is a shell script and aborts the report.
      exclude: [
        "**/node_modules/**",
        "**/*.d.ts",
        "**/*.test.ts",
        "**/__tests__/**",
        "**/*.sh",
      ],
      // Founder-approved 2026-11-17: 70% project floor; the money and consent critical path is 100% per file.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
        "payments/src/ledger.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "payments/src/webhook_core.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "payments/src/delivery.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "web/app/api/billing/webhook/handler.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "web/app/api/billing/checkout/route.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "web/src/lib/consent-chain.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "web/src/lib/creator-consents.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "src/domain/governance/consent.port.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "web/app/creator/consents/actions.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
  resolve: {
    alias: {
      // "server-only" throws outside the react-server condition; stub it for tests.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.js"),
    },
  },
});
