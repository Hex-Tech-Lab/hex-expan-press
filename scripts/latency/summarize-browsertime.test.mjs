// Run with: node --test scripts/latency/summarize-browsertime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = new URL("./summarize-browsertime.mjs", import.meta.url).pathname;

// Browsertime-shaped timings for one iteration.
const timings = (ttfb) => ({
  ttfb,
  firstPaint: { firstPaint: ttfb + 300 },
  largestContentfulPaint: { renderTime: ttfb + 900 },
  loadEventEnd: ttfb + 400,
});
// Page with one iteration per entry in ttfbs.
const pageWithSamples = (url, ttfbs) => ({
  info: { url },
  browserScripts: ttfbs.map((t) => ({ timings: timings(t) })),
});
// Minimal page with one iteration.
const page = (url, ttfb) => pageWithSamples(url, [ttfb]);
const URLS = [
  "https://expanpress.com/",
  "https://expanpress.com/books/retirearly500k",
  "https://expanpress.com/books/retirearly500k/500k-playbook",
];

// `input` is JSON-encoded unless it is a string, which is written as-is.
// `seed` maps file names to contents placed in the output directory before the run.
function run(input, { env = {}, seed = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "latency-test-"));
  const inFile = join(dir, "browsertime.json");
  const out = join(dir, "out");
  writeFileSync(inFile, typeof input === "string" ? input : JSON.stringify(input));
  if (Object.keys(seed).length > 0) {
    mkdirSync(out);
    for (const [name, body] of Object.entries(seed)) writeFileSync(join(out, name), body);
  }
  const res = spawnSync(process.execPath, [script, inFile, out], {
    env: { ...process.env, LATENCY_LOCATION: "gha-test", LATENCY_RUN_AT: "1", ...env },
    encoding: "utf8",
  });
  const files = (() => { try { return readdirSync(out).sort(); } catch { return []; } })();
  return { status: res.status, stderr: res.stderr, files, out };
}

// Parsed summary for one page id from a successful run.
const summaryOf = (r, id) => JSON.parse(readFileSync(join(r.out, `${id}.json`), "utf8"));

test("writes one summary per expected page and exits 0", () => {
  const r = run(URLS.map((u, i) => page(u, 100 + i)));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.files, ["expanpress-home.json", "expanpress-playbook.json", "expanpress-storefront.json"]);
});

test("exits 1 and names the page when a URL no longer matches", () => {
  const r = run([page(URLS[0], 100), page("https://expanpress.com/renamed", 100), page(URLS[2], 100)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing pages: expanpress-storefront/);
});

test("writes no summaries when one expected page is missing", () => {
  const r = run([page(URLS[0], 100), page("https://expanpress.com/renamed", 100), page(URLS[2], 100)]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.files, []);
});

test("exits 2 when the location is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "latency-test-"));
  const input = join(dir, "browsertime.json");
  writeFileSync(input, JSON.stringify(URLS.map((u) => page(u, 100))));
  const res = spawnSync(process.execPath, [script, input, join(dir, "out")], {
    env: { ...process.env, LATENCY_LOCATION: "Bad Location!" },
    encoding: "utf8",
  });
  assert.equal(res.status, 2);
});

// One sample on one page lacks a metric. The run must fail and write nothing, even for the other pages.
const DROP = {
  ttfb: (t) => { delete t.ttfb; },
  firstContentfulPaint: (t) => { delete t.firstPaint; delete t.paintTiming; },
  largestContentfulPaint: (t) => { delete t.largestContentfulPaint; },
  pageLoadTime: (t) => { delete t.loadEventEnd; },
};
for (const [metric, drop] of Object.entries(DROP)) {
  test(`fails the run and writes no summary when one sample lacks ${metric}`, () => {
    const pages = URLS.map((u) => pageWithSamples(u, [100, 100]));
    drop(pages[1].browserScripts[1].timings);
    const r = run(pages);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`sample 2 of 2 has no ${metric}`));
    assert.deepEqual(r.files, []);
  });
}

test("clears stale per-page summaries on a failed run and leaves unrelated files alone", () => {
  const pages = URLS.map((u) => pageWithSamples(u, [100, 100]));
  delete pages[0].browserScripts[1].timings.ttfb;
  const r = run(pages, {
    seed: {
      "expanpress-home.json": '{"stale":true}',
      "expanpress-storefront.json": '{"stale":true}',
      "expanpress-playbook.json": '{"stale":true}',
      "notes.txt": "keep me",
    },
  });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.files, ["notes.txt"]);
});

test("exits 1 with a clear message when the input is not JSON", () => {
  const r = run("{not json");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.deepEqual(r.files, []);
});

test("exits 1 with a clear message when the top-level value is not an array", () => {
  const r = run({ info: { url: URLS[0] }, browserScripts: [] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be a JSON array/);
  assert.deepEqual(r.files, []);
});

for (const bad of ["abc", "", "-1", "1.5"]) {
  test(`exits 2 when LATENCY_RUN_AT is ${JSON.stringify(bad)}`, () => {
    const r = run(URLS.map((u) => page(u, 100)), { env: { LATENCY_RUN_AT: bad } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /LATENCY_RUN_AT/);
    assert.deepEqual(r.files, []);
  });
}

// Timings for one iteration with a custom list of iterations per page.
const pageWithTimings = (url, timingList) => ({
  info: { url },
  browserScripts: timingList.map((t) => ({ timings: t })),
});

// Median: an odd count takes the middle value; an even count takes the mean of the two middle values.
test("median of an odd sample count is the middle value", () => {
  const r = run(URLS.map((u) => pageWithSamples(u, [300, 100, 200])));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(summaryOf(r, "expanpress-home").metrics.ttfb, 200);
});

test("median of an even sample count is the mean of the two middle values, not either one", () => {
  // Sorted: 100, 200, 300, 400. The middle pair is 200 and 300, so the median is 250.
  // The upper middle value would be 300 and the lower 200.
  const r = run(URLS.map((u) => pageWithSamples(u, [400, 100, 300, 200])));
  assert.equal(r.status, 0, r.stderr);
  const s = summaryOf(r, "expanpress-home");
  assert.equal(s.samples, 4);
  assert.equal(s.metrics.ttfb, 250);
});

// A page with no iterations must fail the run. Without this guard it would publish a summary with
// zero samples and zeroed metrics.
const EMPTY_PAGES = [
  ["an empty browserScripts array", { info: { url: URLS[1] }, browserScripts: [] }],
  ["no browserScripts key", { info: { url: URLS[1] } }],
];
for (const [label, emptyPage] of EMPTY_PAGES) {
  test(`exits 1 and writes nothing when the page has ${label}`, () => {
    const r = run([page(URLS[0], 100), emptyPage, page(URLS[2], 100)]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /expanpress-storefront: no samples/);
    assert.deepEqual(r.files, []);
  });
}

// The same page URL twice would make the second copy silently replace the first. The run must fail instead.
test("exits 1 and writes nothing when the same page appears twice", () => {
  const r = run([page(URLS[0], 100), page(URLS[0], 200), page(URLS[1], 100), page(URLS[2], 100)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expanpress-home: appears more than once in the input/);
  assert.deepEqual(r.files, []);
});

// Metrics are rounded to 0.1 ms: a value of .04 rounds down, a value of .06 rounds up.
test("rounds each metric to 0.1 ms", () => {
  const r = run([
    pageWithSamples(URLS[0], [100.04]),
    pageWithSamples(URLS[1], [100.06]),
    pageWithSamples(URLS[2], [100.04]),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(summaryOf(r, "expanpress-home").metrics.ttfb, 100);
  assert.equal(summaryOf(r, "expanpress-storefront").metrics.ttfb, 100.1);
});

// Browsertime 28.4.0 reports first contentful paint under paintTiming and has no firstPaint key.
test("reads first contentful paint from paintTiming when firstPaint is absent", () => {
  const paintTimingOnly = (ttfb) => ({
    ttfb,
    paintTiming: { "first-paint": ttfb + 200, "first-contentful-paint": ttfb + 300 },
    largestContentfulPaint: { renderTime: ttfb + 900 },
    loadEventEnd: ttfb + 400,
  });
  const r = run(URLS.map((u) => pageWithTimings(u, [paintTimingOnly(100)])));
  assert.equal(r.status, 0, r.stderr);
  const m = summaryOf(r, "expanpress-home").metrics;
  assert.equal(m.firstContentfulPaint, 400);
  assert.equal(m.largestContentfulPaint, 1000);
  assert.equal(m.pageLoadTime, 500);
});
