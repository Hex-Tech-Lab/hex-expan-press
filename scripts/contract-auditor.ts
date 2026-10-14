/**
 * Contract Auditor (static rules) -- catches "it compiles, it's not a security bug, and it
 * still silently does the wrong thing" defects that tsc/lint/qa-intel miss.
 *
 * Each rule targets a silent-failure pattern: a missing-config path that exits 0,
 * an unverified external endpoint, or a failure return with no telemetry.
 *
 * This is intentionally a small, high-precision ruleset, not a general
 * linter -- false positives here train people to ignore the tool, which
 * defeats the point. Run: `pnpm contract-audit`.
 * Exits 1 only on CRITICAL findings. It is not wired into CI.
 * bug that used to stay invisible; WARNING findings are informational.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

interface Finding {
  rule: string;
  severity: 'critical' | 'warning';
  file: string;
  line: number;
  /** Stable identity for a finding (rule+file+line). Printed only; no cross-run comparison in this repo. */
  fingerprint?: string;
  why: string;
  snippet: string;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = [join(REPO_ROOT, 'web'), join(REPO_ROOT, 'payments'), join(REPO_ROOT, 'scripts')];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage', '.turbo']);
const CODE_EXT = new Set(['.ts', '.tsx']);
const TEST_MARKERS = ['.test.', '.spec.', '__tests__'];

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (CODE_EXT.has(entry.slice(entry.lastIndexOf('.')))) {
      yield full;
    }
  }
}

function isTestFile(path: string): boolean {
  return TEST_MARKERS.some((m) => path.includes(m));
}

const findings: Finding[] = [];

// --- Rule 1: SILENT_SUCCESS_ON_MISSING_CONFIG ---------------------------
// A script that warns about missing required config and then exits 0 (or
// just `return`s with no non-zero exit) will report success to whatever
// invoked it. Scripts invoked by automation are the highest-risk case -- a green check
// that did nothing is strictly worse than a red one that's honest.
function auditSilentSuccess(file: string, content: string) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!/console\.(warn|error)\(/.test(line)) continue;
    const isMissingConfigWarning = /missing|not (configured|set|found)|skip/i.test(line);
    if (!isMissingConfigWarning) continue;
    // Look ahead a few lines for a bare `process.exit(0)` (or a `return`
    // that would make the caller see success.
    const window = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
    if (/process\.exit\(0\)/.test(window)) {
      findings.push({
        rule: 'SILENT_SUCCESS_ON_MISSING_CONFIG',
        severity: 'critical',
        file,
        line: i + 1,
        why: 'A missing-config warning is immediately followed by process.exit(0) -- the caller sees this as success. If this script is invoked from a workflow step with no other verification, a rotated/emptied credential becomes permanently invisible.',
        snippet: line.trim(),
      });
    }
  }
}

// --- Rule 2: UNVERIFIED_EXTERNAL_ENDPOINT --------------------------------
// A hardcoded call to a known third-party management/analytics API, in a
// non-test file, with no sibling test file for the same module. This is a
// heuristic, not proof of a broken contract -- it flags the SHAPE of risk
// (a guessed API path with nothing ever asserting it still returns 2xx),
// not a certain bug. Kept to a short, deliberately narrow host list so it
// stays high-signal.
const RISKY_HOSTS = [
  'api.supabase.com',
  'qstash.upstash.io',
  'api.vercel.com',
  '.upstash.io',
  'openrouter.ai',
  'api.cloudflare.com',
];
function auditUnverifiedEndpoints(file: string, content: string, hasSiblingTest: boolean) {
  if (hasSiblingTest || isTestFile(file)) return;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const hit = RISKY_HOSTS.find((h) => line.includes(h));
    if (!hit) continue;
    if (!/fetch\(|axios\.|https?:\/\//.test(line)) continue;
    findings.push({
      rule: 'UNVERIFIED_ENDPOINT_NO_TEST',
      severity: 'warning',
      file,
      line: i + 1,
      why: `Hardcoded call to ${hit} with no sibling test file (*.test.ts / *.spec.ts) for this module. Management/analytics API paths drift between API versions with no compile-time signal -- verify this exact path+method+body shape against a live call before trusting it, the way the Supabase logs.all and QStash schedule endpoints in this repo both silently 404'd.`,
      snippet: line.trim(),
    });
  }
}

function stripStringsAndCommentsForBraceCounting(line: string): string {
  let stripped = line.replace(/\/\/.*$/, '');
  stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  stripped = stripped.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  stripped = stripped.replace(/`(?:[^`\\]|\\.)*`/g, '``');
  return stripped;
}

/**
 * Single source of truth for "does this code call a real telemetry sink",
 * separately-maintained copies of the same regex, which is exactly the kind
 * of drift risk that would let this whole rule class silently fall behind
 * actual observability practice as new call sites are added.
 *
 * Covers: console.error/warn, Sentry.captureException/captureMessage, and
 * the bare (non-method) `logError(...)` call from
 * telemetry helper (confirmed by reading its implementation: it dispatches
 * to console.error/warn/info internally), so a file whose only reporting is
 * `logError(...)` was previously invisible to this rule.
 *
 * Deliberately does NOT match `.logError(` (with a preceding dot) --
 * useAnalysisStore's `store.logError(message)` / `analysisStore.getState()
 * .logError(...)` is a DIFFERENT function of the same name that only
 * appends to a client-side UI terminal-log list. It reports nothing to any
 * durable telemetry surface, so treating it as equivalent would silently
 * exempt real silent-failure cases that happen to also touch the UI log.
 */
const TELEMETRY_CALL_PATTERN = /console\.(error|warn)\(|Sentry\.(captureException|captureMessage)\(|(?<!\.)\blogError\(/;

function countBraces(line: string): { open: number; close: number } {
  const cleaned = stripStringsAndCommentsForBraceCounting(line);
  return {
    open: (cleaned.match(/\{/g) || []).length,
    close: (cleaned.match(/\}/g) || []).length,
  };
}

function auditSilentCatchNoTelemetry(file: string, content: string) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const catchMatch = /\bcatch\s*(\([^)]*\))?\s*\{/.exec(line);
    if (!catchMatch) continue;

    // Single-line form: `catch { ... }` opens and closes on the same line
    // (net brace depth 0) -- the most common shape for a deliberately
    // terse silent-ignore, e.g. `catch { /* ignore parse errors */ }`.
    // Check the text after the opening brace on this line directly instead
    // of falling into the multi-line walker below, which would otherwise
    // never run for a same-line block and skip it entirely.
    const afterBrace = line.slice(catchMatch.index + catchMatch[0].length);
    const singleLineBody = /\}\s*$/.test(afterBrace) ? afterBrace.replace(/\}\s*$/, '') : null;
    if (singleLineBody !== null) {
      const hasTelemetry = TELEMETRY_CALL_PATTERN.test(singleLineBody);
      if (hasTelemetry) continue;
      const trimmed = singleLineBody.trim();
      const isTrivial = trimmed === '' || /^\/[/*]/.test(trimmed) || /^(return|continue|break|throw)\b/.test(trimmed);
      if (isTrivial && trimmed !== '') continue; // comment-only or control-flow-only: allowed
      if (trimmed === '') {
        // Fully empty `catch {}` -- worse than a documented ignore, still flag it.
      } else if (isTrivial) {
        continue;
      }
      findings.push({
        rule: 'SILENT_CATCH_NO_TELEMETRY',
        severity: 'warning',
        file,
        line: i + 1,
        why: 'This catch block has no console.error/warn or Sentry.captureException/captureMessage call -- the failure it exists to handle is invisible to every telemetry surface. Confirmed pattern: worker/src/services/a persistence service had 4 of these, one of which was the root cause of a chunk that silently vanished with zero trace anywhere (fixed in a prior fix).',
        snippet: line.trim(),
      });
      continue;
    }

    // Multi-line form: collect the catch block body by brace depth, capped
    // at 15 lines so a huge block doesn't false-negative on telemetry
    // buried far below.
    const openLineBraces = countBraces(line);
    let depth = openLineBraces.open - openLineBraces.close;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && depth > 0 && body.length < 15) {
      const bodyLine = lines[j] ?? '';
      const bodyBraces = countBraces(bodyLine);
      depth += bodyBraces.open - bodyBraces.close;
      if (depth <= 0) break;
      body.push(bodyLine);
      j++;
    }
    if (body.length === 0) continue;

    const joined = body.join('\n');
    const hasTelemetry = TELEMETRY_CALL_PATTERN.test(joined);
    if (hasTelemetry) continue;

    // Benign no-op bodies: a single control-flow statement or a plain
    // fallback assignment/return with nothing else going on.
    const meaningfulLines = body.map((l) => l.trim()).filter((l) => l.length > 0);
    const isTrivialFallback =
      meaningfulLines.length <= 1 &&
      /^(return|continue|break|throw)\b|^[a-zA-Z_$][\w.$]*\s*=\s*[^;]+;?$/.test(meaningfulLines[0] ?? '');
    if (isTrivialFallback) continue;

    findings.push({
      rule: 'SILENT_CATCH_NO_TELEMETRY',
      severity: 'warning',
      file,
      line: i + 1,
      why: 'This catch block has no console.error/warn or Sentry.captureException/captureMessage call anywhere in its body -- the failure it exists to handle is invisible to every telemetry surface. Confirmed pattern: worker/src/services/a persistence service had 4 of these, one of which was the root cause of a chunk that silently vanished with zero trace anywhere (fixed in a prior fix).',
      snippet: line.trim(),
    });
  }
}

// --- Rule 5: SILENT_ERROR_RETURN_NO_TELEMETRY -----------------------------
// A return of a failure object (success/ok set to false) whose
// enclosing block has no error-reporting call anywhere in it. This is the
// non-exceptional sibling of SILENT_CATCH_NO_TELEMETRY: no throw happens, so
// the catch-block heuristic never sees it, but the failure is just as
// of these (non-2xx branches, empty-response branch) with zero telemetry --
// found only via manual crash investigation, not tooling (fixed in
// (walked backward to its opening brace, capped at 15 lines) lacks any
// console.error/warn or Sentry call -- a block that already logs above the
// return is left alone.
function auditSilentErrorReturnNoTelemetry(file: string, content: string) {
  const lines = content.split('\n');
  // Trigger: just the opening of a `return { ... }` object literal -- this
  // reliably sits on one line even when the object body is multi-line
  // (Prettier's default formatting). The full success/ok:false check runs
  // against a forward-joined window below, not this line alone.
  const returnOpenPattern = /\breturn\s*\{/;
  const failureFieldPattern = /\b(success|ok)\s*:\s*false\b/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!returnOpenPattern.test(line)) continue;

    // `line` alone, so `return {\n  success: false,\n  ...\n};` -- the
    // common multi-line object-literal shape -- was invisible to this rule
    // entirely. Join the return line plus up to 6 following lines (enough
    // for a typical 2-4-field failure object) before checking for the
    // success/ok:false field.
    const forwardWindow = lines.slice(i, Math.min(i + 7, lines.length)).join('\n');
    if (!failureFieldPattern.test(forwardWindow)) continue;

    // Walk backward to find the start of the enclosing block: the nearest
    // line above whose net brace balance (relative to the return line)
    // opens the scope this return sits in.
    let depth = 0;
    let blockStart = -1;
    for (let k = i; k >= 0 && i - k <= 15; k--) {
      const kLine = lines[k] ?? '';
      const kBraces = countBraces(kLine);
      depth += kBraces.close - kBraces.open;
      if (depth < 0) {
        blockStart = k;
        break;
      }
    }
    if (blockStart === -1) continue; // no enclosing block found within the cap; skip rather than guess

    const blockLines = lines.slice(blockStart, i + 1);
    const joined = blockLines.join('\n');
    const hasTelemetry = TELEMETRY_CALL_PATTERN.test(joined);
    if (hasTelemetry) continue;

    findings.push({
      rule: 'SILENT_ERROR_RETURN_NO_TELEMETRY',
      severity: 'warning',
      file,
      line: i + 1,
      why: 'This return of a failure object (success/ok set to false) has no console.error/warn or Sentry.captureException/captureMessage call anywhere in its enclosing block -- a real failure path with no throw, so it is invisible to telemetry and to SILENT_CATCH_NO_TELEMETRY alike. Confirmed pattern: an LLM cascade had 4 of these across callLLM/callLLMStream (fixed in a prior fix).',
      snippet: line.trim(),
    });
  }
}

for (const root of SCAN_ROOTS) {
  const dirFiles = [...walk(root)];
  const stems = new Set(dirFiles.map((f) => f.replace(/\.(test|spec)\.tsx?$/, '.___').replace(/\.tsx?$/, '')));
  for (const file of dirFiles) {
    if (isTestFile(file)) continue;
    const content = readFileSync(file, 'utf-8');
    const relPath = relative(REPO_ROOT, file);
    const stem = file.replace(/\.tsx?$/, '');
    const hasSiblingTest = stems.has(`${stem}.___`) || dirFiles.some((f) => isTestFile(f) && f.startsWith(stem));
    auditSilentSuccess(relPath, content);
    auditUnverifiedEndpoints(relPath, content, hasSiblingTest);
    // Self-exemption: this file's own source unavoidably contains the exact
    // pattern strings these two rules search for (their regex literals ARE
    // e.g. `return {` and `success: false`/`catch {`) -- not a wording
    // issue that can be dodged, it's structural to scanning your own
    // detection logic. Every other rule is safe to self-scan.
    const isContractAuditorItself = relPath === 'scripts/contract-auditor.ts';
    if (!isContractAuditorItself) {
      auditSilentCatchNoTelemetry(relPath, content);
      auditSilentErrorReturnNoTelemetry(relPath, content);
    }
  }
}

for (const f of findings) {
  f.fingerprint = createHash('sha1').update(`${f.rule}:${f.file}:${f.line}`).digest('hex').slice(0, 12);
}

const criticalCount = findings.filter((f) => f.severity === 'critical').length;
const warningCount = findings.filter((f) => f.severity === 'warning').length;

function printSummary(remediation: { newCount: number; recurringCount: number; resolvedCount: number } | null) {
  const summary = {
    runAt: new Date().toISOString(),
    criticalCount,
    warningCount,
    remediation,
    findings,
  };
  console.log(JSON.stringify(summary, null, 2));
  const remediationLine = remediation
    ? ` (${remediation.newCount} new, ${remediation.recurringCount} recurring, ${remediation.resolvedCount} resolved since last run)`
    : '';
  console.error(`\nContract Auditor: ${criticalCount} critical, ${warningCount} warning finding(s)${remediationLine}.`);
}

printSummary(null);
process.exit(criticalCount > 0 ? 1 : 0);
