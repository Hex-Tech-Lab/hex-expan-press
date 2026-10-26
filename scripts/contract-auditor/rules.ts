/**
 * Contract auditor rules. Each rule targets a silent-failure pattern: a missing-config path that exits 0,
 * an unverified external endpoint, a catch or failure return with no telemetry.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import { CONTRACT_AUDITOR_CONFIG } from './config';

export interface Finding {
  rule: string;
  severity: 'critical' | 'warning';
  file: string;
  line: number;
  /** Line-stable identity (rule, file, snippet); see fingerprintOf. */
  fingerprint?: string;
  why: string;
  snippet: string;
}


const SKIP_DIRS = new Set(CONTRACT_AUDITOR_CONFIG.skipDirs);
const CODE_EXT = new Set(CONTRACT_AUDITOR_CONFIG.codeExtensions);
const TEST_MARKERS = CONTRACT_AUDITOR_CONFIG.testMarkers;

export function* walk(dir: string): Generator<string> {
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

export function isTestFile(path: string): boolean {
  return TEST_MARKERS.some((m) => path.includes(m));
}

let findings: Finding[] = [];

// --- Rule 1: SILENT_SUCCESS_ON_MISSING_CONFIG ---------------------------
// A script that warns about missing required config and then exits 0 (or
// just `return`s with no non-zero exit) will report success to whatever
// invoked it. Scripts invoked by automation are the highest-risk case -- a green check
// that did nothing is strictly worse than a red one that's honest.
export function auditSilentSuccess(file: string, content: string) {
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
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
const RISKY_HOSTS = CONTRACT_AUDITOR_CONFIG.riskyHosts;
export function auditUnverifiedEndpoints(file: string, content: string, hasSiblingTest: boolean) {
  if (hasSiblingTest || isTestFile(file)) return;
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
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

export function stripStringsAndCommentsForBraceCounting(line: string): string {
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
 * telemetry helper, so a file whose only reporting is `logError(...)` is not
 * flagged by this rule.
 *
 * Deliberately does NOT match `.logError(` (with a preceding dot) --
 * useAnalysisStore's `store.logError(message)` / `analysisStore.getState()
 * .logError(...)` is a DIFFERENT function of the same name that only
 * appends to a client-side UI terminal-log list. It reports nothing to any
 * durable telemetry surface, so treating it as equivalent would silently
 * exempt real silent-failure cases that happen to also touch the UI log.
 */
const TELEMETRY_CALL_PATTERN = /console\.(error|warn)\(|Sentry\.(captureException|captureMessage)\(|(?<!\.)\blogError\(/;

export function countBraces(line: string): { open: number; close: number } {
  const cleaned = stripStringsAndCommentsForBraceCounting(line);
  return {
    open: (cleaned.match(/\{/g) || []).length,
    close: (cleaned.match(/\}/g) || []).length,
  };
}

/** Code with comments and string contents blanked, one entry per line, so a rule cannot match text inside a string or comment. */
function codeLines(content: string): string[] {
  return content.split('\n').map(stripStringsAndCommentsForBraceCounting);
}

export function auditSilentCatchNoTelemetry(file: string, content: string) {
  const lines = content.split('\n');
  const code = codeLines(content);
  for (const [i, line] of lines.entries()) {
    const codeLine = code[i] as string;
    const catchMatch = /\bcatch\s*(\([^)]*\))?\s*\{/.exec(codeLine);
    if (!catchMatch) continue;

    // Single-line form: `catch { ... }` opens and closes on the same line
    // (net brace depth 0) -- the most common shape for a deliberately
    // terse silent-ignore, e.g. `catch { /* ignore parse errors */ }`.
    // Check the text after the opening brace on this line directly instead
    // of falling into the multi-line walker below, which would otherwise
    // never run for a same-line block and skip it entirely.
    const afterBrace = codeLine.slice(catchMatch.index + catchMatch[0].length);
    const singleLineBody = /\}\s*$/.test(afterBrace) ? afterBrace.replace(/\}\s*$/, '') : null;
    if (singleLineBody !== null) {
      if (TELEMETRY_CALL_PATTERN.test(singleLineBody)) continue;
      // Comment-only or control-flow-only bodies are deliberate and allowed. An empty `catch {}` matches
      // neither, so it is still flagged: it is worse than a documented ignore.
      const trimmed = singleLineBody.trim();
      const isDeliberate = /^\/[/*]/.test(trimmed) || /^(return|continue|break|throw)\b/.test(trimmed);
      if (isDeliberate) continue;
      findings.push({
        rule: 'SILENT_CATCH_NO_TELEMETRY',
        severity: 'warning',
        file,
        line: i + 1,
        why: 'This catch block has no console.error/warn or Sentry.captureException/captureMessage call -- the failure it exists to handle is invisible to every telemetry surface.',
        snippet: line.trim(),
      });
      continue;
    }

    // Multi-line form: collect the catch block body by brace depth, capped
    // at 15 lines to keep the scan bounded; a telemetry call past that cap is not seen (accepted).
    // The catch's own opening brace is consumed by the match above, so depth starts at 1 and counts only
    // the rest of the line. Counting the whole line would let a leading `}` (as in `} catch (e) {`) cancel
    // the opener and hide the entire block.
    const restBraces = countBraces(afterBrace);
    let depth = 1 + restBraces.open - restBraces.close;
    const body: string[] = [];
    let j = i + 1;
    while (j < code.length && depth > 0 && body.length < 15) {
      const bodyCode = code[j] as string; // j < code.length by the loop guard
      const bodyBraces = countBraces(bodyCode);
      depth += bodyBraces.open - bodyBraces.close;
      if (depth <= 0) break;
      body.push(bodyCode);
      j++;
    }
    if (TELEMETRY_CALL_PATTERN.test(body.join('\n'))) continue;
    // A documented ignore (a body of comments only) is allowed, as in the single-line form. A blank body is not.
    const rawBody = lines.slice(i + 1, j);
    const isComment = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l);
    if (rawBody.some(isComment) && rawBody.every((l) => l.trim() === '' || isComment(l))) continue;

    // Benign no-op bodies: a single control-flow statement or a plain
    // fallback assignment/return with nothing else going on.
    // An empty body is flagged too: `catch (e) {}` is the same silent swallow as the single-line form.
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
      why: 'This catch block has no console.error/warn or Sentry.captureException/captureMessage call anywhere in its body -- the failure it exists to handle is invisible to every telemetry surface.',
      snippet: line.trim(),
    });
  }
}

// --- Rule 5: SILENT_ERROR_RETURN_NO_TELEMETRY -----------------------------
// A return of a failure object (success/ok set to false) whose enclosing
// scope has no error-reporting call. This is the non-exceptional sibling of
// SILENT_CATCH_NO_TELEMETRY: no throw happens, so the catch-block heuristic never sees it. A block is flagged
// only when its enclosing scope (found by walking backward to the opening brace, capped at 15 lines) has no
// console.error/warn or Sentry call; a block that already logs above the return is left alone.
export function auditSilentErrorReturnNoTelemetry(file: string, content: string) {
  const lines = content.split('\n');
  const code = codeLines(content);
  // Trigger: just the opening of a `return { ... }` object literal -- this
  // reliably sits on one line even when the object body is multi-line
  // (Prettier's default formatting). The full success/ok:false check runs
  // against a forward-joined window below, not this line alone.
  const returnOpenPattern = /\breturn\s*\{/;
  const failureFieldPattern = /\b(success|ok)\s*:\s*false\b/;

  for (const [i, line] of lines.entries()) {
    if (!returnOpenPattern.test(code[i] as string)) continue;

    // Join the return line plus up to 6 following lines (enough for a typical
    // 2-4-field failure object) so a multi-line object literal is matched too.
    const forwardWindow = code.slice(i, Math.min(i + 7, code.length)).join('\n');
    if (!failureFieldPattern.test(forwardWindow)) continue;

    // Walk backward to find the start of the enclosing block: the nearest
    // line above whose net brace balance (relative to the return line)
    // opens the scope this return sits in.
    let depth = 0;
    let blockStart = -1;
    // Start one line above the return: the return's own object literal opens a brace that is not an enclosing scope.
    for (let k = i - 1; k >= 0 && i - k <= 15; k--) {
      const kBraces = countBraces(code[k] as string);
      depth += kBraces.close - kBraces.open;
      if (depth < 0) {
        blockStart = k;
        break;
      }
    }
    if (blockStart === -1) continue; // no enclosing block found within the cap; skip rather than guess

    if (TELEMETRY_CALL_PATTERN.test(code.slice(blockStart, i + 1).join('\n'))) continue;

    findings.push({
      rule: 'SILENT_ERROR_RETURN_NO_TELEMETRY',
      severity: 'warning',
      file,
      line: i + 1,
      why: 'This return of a failure object (success/ok set to false) has no console.error/warn or Sentry.captureException/captureMessage call anywhere in its enclosing block -- a real failure path with no throw, so it is invisible to telemetry and to SILENT_CATCH_NO_TELEMETRY alike.',
      snippet: line.trim(),
    });
  }
}

/** Runs one rule over content and returns what it recorded. Used by the rule tests to drive a rule directly. */
export function collectFindings(run: () => void): Finding[] {
  findings = [];
  run();
  return [...findings];
}

export function scan(repoRoot: string): Finding[] {
  findings = [];
  for (const root of CONTRACT_AUDITOR_CONFIG.scanRoots.map((r) => join(repoRoot, r))) {
    const dirFiles = [...walk(root)];
    const stems = new Set(dirFiles.map((f) => f.replace(/\.(test|spec)\.tsx?$/, '.___').replace(/\.tsx?$/, '')));
    for (const file of dirFiles) {
      if (isTestFile(file)) continue;
      const content = readFileSync(file, 'utf-8');
      const relPath = relative(repoRoot, file);
      const stem = file.replace(/\.tsx?$/, '');
      const hasSiblingTest = stems.has(`${stem}.___`) || dirFiles.some((f) => isTestFile(f) && f.startsWith(stem));
      auditSilentSuccess(relPath, content);
      auditUnverifiedEndpoints(relPath, content, hasSiblingTest);
      // Self-exemption: these files contain the exact patterns the two no-telemetry rules search for,
      // so they cannot be scanned for those rules without flagging their own detection logic.
      const isSelf = CONTRACT_AUDITOR_CONFIG.selfFiles.includes(relPath);
      if (!isSelf) {
        auditSilentCatchNoTelemetry(relPath, content);
        auditSilentErrorReturnNoTelemetry(relPath, content);
      }
    }
  }
  for (const f of findings) {
    f.fingerprint = fingerprintOf(f);
  }
  return [...findings];
}

/** Line-stable identity: an edit above a finding must not make an accepted finding look new. */
export function fingerprintOf(f: Pick<Finding, 'rule' | 'file' | 'snippet'>): string {
  return createHash('sha1').update(`${f.rule}:${f.file}:${f.snippet}`).digest('hex').slice(0, 12);
}
