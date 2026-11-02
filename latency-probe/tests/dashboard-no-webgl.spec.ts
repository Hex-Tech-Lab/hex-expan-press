import { expect, test } from "@playwright/test";

// A browser without WebGL cannot start the chart. The cards and tables must still render, and the
// page must say why the chart is missing. The data is served by a route, so no Redis env is needed.
test.use({
  launchOptions: {
    executablePath: process.env.PROBE_CHROME_PATH || undefined,
    args: ["--disable-webgl", "--disable-webgl2", "--disable-3d-apis"],
  },
});

const HALF = 30 * 60_000;
const now = Date.now();
const fixture = {
  generatedAt: now,
  window: "24h",
  windowHours: 24,
  lastRunTs: now - HALF,
  firstRunTs: now - 2 * HALF,
  nextRunAt: now + HALF,
  targetCount: 1,
  targetIds: ["expanpress-home"],
  locations: [{ id: "iad1", label: "Vercel iad1, Ashburn VA (baseline)" }],
  runs: [
    { ts: now - 2 * HALF, loc: { iad1: { n: 7, ok: 7, err: 0, to: 0, rt: 0, et: {}, ttfb: 200, total: 600 } } },
    { ts: now - HALF, loc: { iad1: { n: 7, ok: 7, err: 0, to: 0, rt: 0, et: {}, ttfb: 220, total: 640 } } },
  ],
  series: {},
  pages: [{ id: "expanpress-home", label: "ExpanPress home" }],
  sources: ["sitespeed.io"],
  browser: [
    {
      schema: 1,
      source: "sitespeed.io",
      page: "expanpress-home",
      location: "us-east",
      runAt: now - HALF,
      samples: 5,
      metrics: { ttfb: 310, firstContentfulPaint: 900, largestContentfulPaint: 1800, pageLoadTime: 2400 },
    },
  ],
};

test("cards and tables still render when WebGL is unavailable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/dashboard-data**", (r) => r.fulfill({ json: fixture }));
  // The real three.js loads from jsDelivr (as on the live page). The browser flags above stop WebGL,
  // so the renderer cannot be created. A stubbed three.js answers too fast and races React hydration.

  await page.goto("/");

  await expect(page.locator("#cards .stat")).toHaveCount(2);
  await expect(page.locator("#latest-body tr")).toHaveCount(1);
  await expect(page.locator("#chart-note")).toContainText("WebGL");
  await expect(page.locator("#status")).not.toHaveText("Loading the latest data.");
  expect(errors).toEqual([]);
});
