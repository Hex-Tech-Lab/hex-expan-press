// Turns Browsertime's browsertime.json into one signed-ready summary per page.
// Usage: node summarize-browsertime.mjs <browsertime.json> <outDir>
// Env:   LATENCY_LOCATION (lowercase a-z0-9-, e.g. gha-us), LATENCY_RUN_AT (ms epoch, optional)
// Output: <outDir>/<page-id>.json, one per expected page, matching the probe ingest schema v1.
// Exits 1 if any expected page is missing, so a partial run cannot pass.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PAGE_IDS = new Map([
  ["https://expanpress.com/", "expanpress-home"],
  ["https://expanpress.com/books/retirearly500k", "expanpress-storefront"],
  ["https://expanpress.com/books/retirearly500k/500k-playbook", "expanpress-playbook"],
]);

const [, , inFile, outDir] = process.argv;
if (!inFile || !outDir) {
  console.error("usage: summarize-browsertime.mjs <browsertime.json> <outDir>");
  process.exit(2);
}
const location = process.env.LATENCY_LOCATION ?? "";
if (!/^[a-z0-9-]{1,40}$/.test(location)) {
  console.error("LATENCY_LOCATION must match ^[a-z0-9-]{1,40}$");
  process.exit(2);
}
const runAt = Number(process.env.LATENCY_RUN_AT ?? Date.now());

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Shapes checked against browsertime 28.4.0 (browserscripts/timings): paintTiming is keyed by entry name.
// timings.firstPaint is a bare number for first-paint, not FCP, so it is not read here.
const fcpOf = (t) => num(t.paintTiming?.["first-contentful-paint"]);
const lcpOf = (t) => num(t.largestContentfulPaint?.renderTime);

const pages = JSON.parse(readFileSync(inFile, "utf8"));
mkdirSync(outDir, { recursive: true });
const written = [];

for (const page of pages) {
  const url = page.info?.url ?? page.info?.name ?? "";
  const id = PAGE_IDS.get(url);
  if (!id) {
    console.error(`skip: unrecognised page URL ${url}`);
    continue;
  }
  const iterations = (page.browserScripts ?? []).map((b) => b.timings ?? {});
  const ttfb = iterations.map((t) => num(t.ttfb)).filter((v) => v !== null);
  const fcp = iterations.map(fcpOf).filter((v) => v !== null);
  const lcp = iterations.map(lcpOf).filter((v) => v !== null);
  const load = iterations.map((t) => num(t.loadEventEnd)).filter((v) => v !== null);
  if (ttfb.length === 0) {
    console.error(`skip: no TTFB samples for ${id}`);
    continue;
  }
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  const summary = {
    schema: 1,
    source: "sitespeed.io",
    page: id,
    location,
    runAt,
    samples: iterations.length,
    metrics: {
      ttfb: round(median(ttfb)),
      firstContentfulPaint: round(median(fcp)),
      largestContentfulPaint: round(median(lcp)),
      pageLoadTime: round(median(load)),
    },
  };
  const file = join(outDir, `${id}.json`);
  writeFileSync(file, JSON.stringify(summary));
  written.push(file);
  console.log(`${id}: n=${summary.samples} ttfb=${summary.metrics.ttfb} fcp=${summary.metrics.firstContentfulPaint} lcp=${summary.metrics.largestContentfulPaint} load=${summary.metrics.pageLoadTime}`);
}

// Fail when any expected page is missing, so a renamed URL cannot pass the job with partial data.
const measured = new Set(written.map((f) => f.split("/").pop().replace(/\.json$/, "")));
const missing = [...PAGE_IDS.values()].filter((id) => !measured.has(id));
if (missing.length > 0) {
  console.error(`missing pages: ${missing.join(", ")}`);
  process.exit(1);
}
