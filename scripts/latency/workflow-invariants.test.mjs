// Run with: node --test scripts/latency/workflow-invariants.test.mjs
// Guards the Cubic P1 fix: the job that runs Chrome must never hold the probe secret, Chrome keeps its sandbox,
// and the send job runs no browser.
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
  if (/no-sandbox/.test(code)) violations.push("--no-sandbox present");
  if (measure && SECRET_REF.test(measure)) violations.push("secret reachable from measure job");
  if (send) {
    // Every secret reference (top-level env, expressions, toJSON(secrets)) must sit inside the send job.
    if (SECRET_REF.test(code.replace(send, ""))) violations.push("secret reference outside send job");
    if (!/PROBE_INGEST_SECRET/.test(send)) violations.push("send job lacks the probe secret");
    if (BROWSER_TOOL.test(send)) violations.push("send job runs a browser tool");
    if (!/^    needs: measure\s*$/m.test(send)) violations.push("send job does not depend on measure");
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
      "--no-sandbox present",
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
  ];
  for (const [label, bad, expected] of cases) {
    assert.ok(invariantViolations(bad).includes(expected), `${label}: expected "${expected}"`);
  }
});
