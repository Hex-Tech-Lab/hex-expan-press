// Run with: node --test scripts/latency/workflow-invariants.test.mjs
// Guards the Cubic P1 fix: the job that runs Chrome must never hold the probe secret, no Chrome sandbox
// switch (--no-sandbox or --disable-setuid-sandbox) may appear, the send job runs no browser, and the send job
// runs only on master (its if: guard).
// It checks the workflow text only; it does not observe Chrome's sandbox at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKFLOW = new URL("../../.github/workflows/real-browser-latency.yml", import.meta.url);
const JOB_KEY = /^  [A-Za-z0-9_-]+:\s*$/;
const SECRET_REF = /PROBE_INGEST_SECRET|\bsecrets\b/;
const BROWSER_TOOL = /google-chrome|chromium|chromedriver|browsertime|puppeteer|playwright/i;

// Text of one job: from its "  <name>:" line up to the next two-space job key.
function jobBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (JOB_KEY.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Drops comment lines so header notes do not count as references.
const codeOnly = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

// Returns the violated invariants (empty when the workflow is clean).
export function invariantViolations(text) {
  const violations = [];
  const code = codeOnly(text);
  const measure = jobBlock(code, "measure");
  const send = jobBlock(code, "send");
  if (!measure) violations.push("missing measure job");
  if (!send) violations.push("missing send job");
  if (/--no-sandbox|--disable-setuid-sandbox/.test(code)) violations.push("Chrome sandbox disabled");
  if (measure && SECRET_REF.test(measure)) violations.push("secret reachable from measure job");
  // Browsertime 28 ignores --chrome.headless, so Chrome starts headful on a runner with no display.
  if (measure && /--chrome\.headless\b/.test(measure)) violations.push("measure job uses --chrome.headless, which Browsertime 28 ignores");
  if (measure && !/^\s+--headless\s*\\?\s*$/m.test(measure)) violations.push("measure job lacks --headless");
  if (send) {
    // Every secret reference (top-level env, expressions, toJSON(secrets)) must sit inside the send job.
    if (SECRET_REF.test(code.replace(send, ""))) violations.push("secret reference outside send job");
    if (!/PROBE_INGEST_SECRET/.test(send)) violations.push("send job lacks the probe secret");
    if (BROWSER_TOOL.test(send)) violations.push("send job runs a browser tool");
    if (!/^    needs: measure\s*$/m.test(send)) violations.push("send job does not depend on measure");
    if (!/^    if: github\.ref == 'refs\/heads\/master'\s*$/m.test(send)) violations.push("send job does not run only on master");
  }
  return violations;
}

function mutate(good, from, to) {
  const bad = good.replace(from, to);
  assert.notEqual(bad, good, `mutation target not found: ${from.trim()}`);
  return bad;
}

test("the workflow satisfies the secret-split and sandbox invariants", () => {
  assert.deepEqual(invariantViolations(readFileSync(WORKFLOW, "utf8")), []);
});

test("negative controls: each bypass shape is caught", () => {
  const good = readFileSync(WORKFLOW, "utf8");
  const cases = [
    [
      "--no-sandbox added to Chrome args",
      mutate(good, "--chrome.args=--disable-dev-shm-usage \\", "--chrome.args=--no-sandbox \\\n            --chrome.args=--disable-dev-shm-usage \\"),
      "Chrome sandbox disabled",
    ],
    [
      "--disable-setuid-sandbox added to Chrome args",
      mutate(good, "--chrome.args=--disable-dev-shm-usage \\", "--chrome.args=--disable-setuid-sandbox \\\n            --chrome.args=--disable-dev-shm-usage \\"),
      "Chrome sandbox disabled",
    ],
    [
      "secret in measure job env",
      mutate(good, "    timeout-minutes: 25\n", "    timeout-minutes: 25\n    env:\n      PROBE_INGEST_SECRET: ${{ secrets.PROBE_INGEST_SECRET }}\n"),
      "secret reachable from measure job",
    ],
    [
      "secret in top-level env",
      mutate(good, "name: real-browser-latency\n", "name: real-browser-latency\nenv:\n  PROBE_INGEST_SECRET: ${{ secrets.PROBE_INGEST_SECRET }}\n"),
      "secret reference outside send job",
    ],
    [
      "toJSON(secrets) in measure job",
      mutate(good, "    timeout-minutes: 25\n", "    timeout-minutes: 25\n    env:\n      ALL: ${{ toJSON(secrets) }}\n"),
      "secret reachable from measure job",
    ],
    [
      "browser tool added to send job",
      mutate(good, "    needs: measure\n", "    needs: measure\n    env:\n      BROWSER: chromium\n"),
      "send job runs a browser tool",
    ],
    [
      "measure job reverts to --chrome.headless",
      mutate(good, "            --headless \\\n", "            --chrome.headless \\\n"),
      "measure job uses --chrome.headless, which Browsertime 28 ignores",
    ],
    [
      "measure job drops --headless",
      mutate(good, "            --headless \\\n", ""),
      "measure job lacks --headless",
    ],
    [
      "master-only if: guard removed from send job",
      mutate(good, "    if: github.ref == 'refs/heads/master'\n", ""),
      "send job does not run only on master",
    ],
  ];
  for (const [label, bad, expected] of cases) {
    assert.ok(invariantViolations(bad).includes(expected), `${label}: expected "${expected}"`);
  }
});
