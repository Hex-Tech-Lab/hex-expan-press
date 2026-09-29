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
      "web/__tests__/**/*.test.ts",
    ],
    environment: "node",
  },
  resolve: {
    alias: {
      // "server-only" throws outside the react-server condition; stub it for tests.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.js"),
    },
  },
});
