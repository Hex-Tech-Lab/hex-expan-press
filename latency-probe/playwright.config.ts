import { defineConfig } from "@playwright/test";

// Browser tests run against a production build, started on its own port.
// Set PROBE_CHROME_PATH to a Chrome binary to use it instead of Playwright's bundled browser.
const PORT = 3123;

export default defineConfig({
  testDir: "tests",
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 390, height: 900 } },
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
