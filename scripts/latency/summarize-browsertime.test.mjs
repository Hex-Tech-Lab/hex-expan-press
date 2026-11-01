// Run with: node --test scripts/latency/summarize-browsertime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = new URL("./summarize-browsertime.mjs", import.meta.url).pathname;

// Minimal Browsertime-shaped page with one iteration.
const page = (url, ttfb) => ({
  info: { url },
  browserScripts: [{ timings: { ttfb, firstPaint: { firstPaint: ttfb + 300 }, largestContentfulPaint: { renderTime: ttfb + 900 }, loadEventEnd: ttfb + 400 } }],
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
  return { status: res.status, stderr: res.stderr, files };
}

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
