// Turns Browsertime's browsertime.json into one signed-ready summary per page.
// Usage: node summarize-browsertime.mjs <browsertime.json> <outDir>
// Env:   LATENCY_LOCATION (lowercase a-z0-9-, e.g. gha-us), LATENCY_RUN_AT (ms epoch integer, optional)
// Output: <outDir>/<page-id>.json, one per expected page, matching the probe ingest schema v1.
// Exit codes: 2 = usage or config error (arguments, LATENCY_LOCATION, LATENCY_RUN_AT).
//             1 = bad or incomplete input (unreadable or non-JSON file, non-array top level,
//                 a missing expected page, or any sample without all four metrics).
// Every page is validated before any file is written. Stale <page-id>.json files from an earlier
// run are deleted at startup, so a failed run cannot leave a publishable summary behind.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const PAGE_IDS = new Map([
  ["https://expanpress.com/", "expanpress-home"],
  ["https://expanpress.com/books/retirearly500k", "expanpress-storefront"],
  ["https://expanpress.com/books/retirearly500k/500k-playbook", "expanpress-playbook"],
]);
const METRICS = ["ttfb", "firstContentfulPaint", "largestContentfulPaint", "pageLoadTime"];

const [, , inFile, outDir] = process.argv;
if (!inFile || !outDir) {
  console.error("usage: summarize-browsertime.mjs <browsertime.json> <outDir>");
  process.exit(2);
}

// Clear expected outputs from an earlier run before anything else can fail. Unrelated files are left alone.
for (const id of PAGE_IDS.values()) rmSync(join(outDir, `${id}.json`), { force: true });

const location = process.env.LATENCY_LOCATION ?? "";
if (!/^[a-z0-9-]{1,40}$/.test(location)) {
  console.error("LATENCY_LOCATION must match ^[a-z0-9-]{1,40}$");
  process.exit(2);
}
const runAtEnv = process.env.LATENCY_RUN_AT;
let runAt = Date.now();
if (runAtEnv !== undefined) {
  if (!/^[0-9]+$/.test(runAtEnv) || !Number.isSafeInteger(Number(runAtEnv))) {
    console.error(`LATENCY_RUN_AT must be a ms epoch integer, got ${JSON.stringify(runAtEnv)}`);
    process.exit(2);
  }
  runAt = Number(runAtEnv);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v) => Math.round(v * 10) / 10;

// Browsertime reports paint and LCP under different shapes across versions; take whichever is present.
const fcpOf = (t) => num(t.firstPaint?.firstPaint) ?? num(t.paintTiming?.["first-contentful-paint"]);
const lcpOf = (t) => num(t.largestContentfulPaint?.renderTime) ?? num(t.largestContentfulPaint);

let raw;
try {
  raw = readFileSync(inFile, "utf8");
} catch (err) {
  console.error(`cannot read browsertime input ${inFile}: ${err.code ?? err.message}`);
  process.exit(1);
}
let pages;
try {
  pages = JSON.parse(raw);
} catch (err) {
  console.error(`browsertime input is not valid JSON: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(pages)) {
  console.error("browsertime input must be a JSON array of pages");
  process.exit(1);
}

// Build every summary in memory first. Nothing is written until all expected pages have passed.
const errors = [];
const summaries = [];
const seen = new Set();

for (const page of pages) {
  const url = page?.info?.url ?? page?.info?.name ?? "";
  const id = PAGE_IDS.get(url);
  if (!id) {
    console.error(`skip: unrecognised page URL ${url}`);
    continue;
  }
  if (seen.has(id)) {
    errors.push(`${id}: appears more than once in the input`);
    continue;
  }
  seen.add(id);
  const iterations = (Array.isArray(page.browserScripts) ? page.browserScripts : []).map((b) => b?.timings ?? {});
  if (iterations.length === 0) {
    errors.push(`${id}: no samples`);
    continue;
  }
  const samples = iterations.map((t) => ({
    ttfb: num(t.ttfb),
    firstContentfulPaint: fcpOf(t),
    largestContentfulPaint: lcpOf(t),
    pageLoadTime: num(t.loadEventEnd),
  }));
  // Every sample needs every metric. A partial sample would make the median cover a different set of runs per metric.
  let complete = true;
  samples.forEach((s, i) => {
    for (const m of METRICS) {
      if (s[m] === null) {
        errors.push(`${id}: sample ${i + 1} of ${samples.length} has no ${m}`);
        complete = false;
      }
    }
  });
  if (!complete) continue;
  const metric = (m) => round(median(samples.map((s) => s[m])));
  summaries.push({
    schema: 1,
    source: "sitespeed.io",
    page: id,
    location,
    runAt,
    samples: samples.length,
    metrics: {
      ttfb: metric("ttfb"),
      firstContentfulPaint: metric("firstContentfulPaint"),
      largestContentfulPaint: metric("largestContentfulPaint"),
      pageLoadTime: metric("pageLoadTime"),
    },
  });
}

// Fail when any expected page is missing, so a renamed URL cannot pass the job with partial data.
const measured = new Set(summaries.map((s) => s.page));
const missing = [...PAGE_IDS.values()].filter((id) => !measured.has(id));
if (missing.length > 0) errors.push(`missing pages: ${missing.join(", ")}`);
if (errors.length > 0) {
  for (const e of errors) console.error(e);
  console.error("no summaries written");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
for (const s of summaries) {
  writeFileSync(join(outDir, `${s.page}.json`), JSON.stringify(s));
  console.log(`${s.page}: n=${s.samples} ttfb=${s.metrics.ttfb} fcp=${s.metrics.firstContentfulPaint} lcp=${s.metrics.largestContentfulPaint} load=${s.metrics.pageLoadTime}`);
}
