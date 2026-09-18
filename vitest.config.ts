import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["payments/test/**/*.test.ts"],
    environment: "node",
  },
});
