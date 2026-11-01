// Run with: node --test scripts/latency/workflow-invariants.test.mjs
// Guards the Cubic P1 fix: the job that runs Chrome must never hold the probe secret, Chrome keeps its sandbox,
// and the send job runs no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKFLOW = new URL("../../.github/workflows/real-browser-latency.yml", import.meta.url);

// Text of one job: from its "  <name>:" line up to the next two-space job key.
function jobBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Returns the violated invariants (empty when the workflow is clean).
export function invariantViolations(text) {
  const violations = [];
  const measure = jobBlock(text, "measure");
  const send = jobBlock(text, "send");
  if (!measure) violations.push("missing measure job");
  if (!send) violations.push("missing send job");
  if (/no-sandbox/.test(text)) violations.push("--no-sandbox present");
  if (measure && /PROBE_INGEST_SECRET|secrets\./.test(measure)) violations.push("secret reachable from measure job");
  if (send && !/PROBE_INGEST_SECRET/.test(send)) violations.push("send job lacks the probe secret");
  if (send && /google-chrome|chromedriver|browsertime/.test(send)) violations.push("send job runs a browser tool");
  if (send && !/^    needs: measure\s*$/m.test(send)) violations.push("send job does not depend on measure");
  return violations;
}

test("the workflow satisfies the secret-split and sandbox invariants", () => {
  assert.deepEqual(invariantViolations(readFileSync(WORKFLOW, "utf8")), []);
});

test("negative control: re-adding --no-sandbox or a secret to measure is caught", () => {
  const good = readFileSync(WORKFLOW, "utf8");

  const withFlag = good.replace(
    "--chrome.args=--disable-dev-shm-usage \\",
    "--chrome.args=--no-sandbox \\\n            --chrome.args=--disable-dev-shm-usage \\",
  );
  assert.notEqual(withFlag, good, "flag injection must change the workflow text");
  assert.ok(invariantViolations(withFlag).includes("--no-sandbox present"));

  const withSecret = good.replace(
    "    timeout-minutes: 25\n",
    "    timeout-minutes: 25\n    env:\n      PROBE_INGEST_SECRET: ${{ secrets.PROBE_INGEST_SECRET }}\n",
  );
  assert.notEqual(withSecret, good, "secret injection must change the workflow text");
  assert.ok(invariantViolations(withSecret).includes("secret reachable from measure job"));
});
