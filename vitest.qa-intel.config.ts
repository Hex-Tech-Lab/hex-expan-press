import path from "node:path";
import { defineConfig } from "vitest/config";

/** Files this port authored or adapted. Every one must reach 100% line, branch, function and statement coverage. */
const PORT_OWNED_FILES = [
  "scripts/qa-intel/config.ts",
  "scripts/qa-intel/base-ref.ts",
  "scripts/qa-intel/cache-mode.ts",
  "scripts/qa-intel/engine/redis-port.ts",
  "scripts/qa-intel/engine/cache.ts",
  "scripts/contract-auditor/**/*.ts",
];

// Standalone on purpose: mergeConfig concatenates include arrays, which would pull in the whole suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/qa-intel/__tests__/**/*.test.ts", "scripts/contract-auditor/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: PORT_OWNED_FILES,
      // Entry shim: v8 cannot collect coverage from a spawned child, so its behaviour (exit codes, stderr) is
      // asserted by scripts/contract-auditor/__tests__/shim.test.ts, which runs it under tsx.
      exclude: ["scripts/contract-auditor/__tests__/**", "scripts/contract-auditor.ts"],
      reporter: ["text"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
  resolve: {
    alias: {
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.js"),
    },
  },
});
