// Run with: node --test scripts/latency/summarize-browsertime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = new URL("./summarize-browsertime.mjs", import.meta.url).pathname;

// Minimal Browsertime-shaped page with one iteration. Shapes match browsertime 28.4.0: firstPaint is a
// number, paintTiming is keyed by entry name, LCP is an object with renderTime.
const page = (url, ttfb) => ({
  info: { url },
  browserScripts: [{ timings: {
    ttfb,
    loadEventEnd: ttfb + 400,
    firstPaint: ttfb + 200,
    paintTiming: { "first-paint": ttfb + 200, "first-contentful-paint": ttfb + 300 },
    largestContentfulPaint: { renderTime: ttfb + 900 },
  } }],
});
const URLS = [
  "https://expanpress.com/",
  "https://expanpress.com/books/retirearly500k",
  "https://expanpress.com/books/retirearly500k/500k-playbook",
];

function run(pages) {
  const dir = mkdtempSync(join(tmpdir(), "latency-test-"));
  const input = join(dir, "browsertime.json");
  const out = join(dir, "out");
  writeFileSync(input, JSON.stringify(pages));
  const res = spawnSync(process.execPath, [script, input, out], {
    env: { ...process.env, LATENCY_LOCATION: "gha-test", LATENCY_RUN_AT: "1" },
    encoding: "utf8",
  });
  const files = (() => { try { return readdirSync(out).sort(); } catch { return []; } })();
  return { status: res.status, stderr: res.stderr, files, out };
}

test("writes one summary per expected page and exits 0", () => {
  const r = run(URLS.map((u, i) => page(u, 100 + i)));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.files, ["expanpress-home.json", "expanpress-playbook.json", "expanpress-storefront.json"]);
});

test("reads FCP from paintTiming and load time from loadEventEnd", () => {
  const r = run(URLS.map((u) => page(u, 100)));
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(readFileSync(join(r.out, "expanpress-home.json"), "utf8"));
  assert.equal(s.metrics.ttfb, 100);
  assert.equal(s.metrics.firstContentfulPaint, 400);
  assert.equal(s.metrics.largestContentfulPaint, 1000);
  assert.equal(s.metrics.pageLoadTime, 500);
});

test("exits 1 and names the page when a URL no longer matches", () => {
  const r = run([page(URLS[0], 100), page("https://expanpress.com/renamed", 100), page(URLS[2], 100)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing pages: expanpress-storefront/);
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
