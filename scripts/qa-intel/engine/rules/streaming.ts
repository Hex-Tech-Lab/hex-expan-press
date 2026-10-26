import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

/**
 * True if a same-file function/arrow-function/function-expression named
 * `functionName` has text matching `pattern` anywhere in its body. Shared by
 * functionBodyHasSentry and functionBodyHasAbortDetection below, so a catch
 * block that DELEGATES to a shared helper (instead of inlining detection
 * and/or reporting) still counts correctly on both checks -- RCA
 * (2026-07-31): dimension-remediation.ts extracted a `reportAbortableError`
 * helper to deduplicate two near-identical catch blocks (a real Codacy
 * duplication finding), which moved BOTH the AbortError/isTimeout detection
 * AND the Sentry.captureException call out of the catch blocks' own text --
 * false-positiving this rule a third time, on two different checks at once.
 * Resolving one level of call indirection is enough for this codebase's
 * actual pattern (a local helper in the same file); this deliberately does
 * NOT chase imports or multi-level call chains -- diminishing returns for a
 * heuristic rule, and a real gap should still surface if the helper itself
 * silently does nothing.
 */
function functionBodyMatches(source: SourceFile, functionName: string, pattern: RegExp): boolean {
  let found = false;
  source.forEachDescendant((node) => {
    if (found) return;
    if (Node.isFunctionDeclaration(node) && node.getName() === functionName) {
      found = pattern.test(node.getBodyText() ?? "");
      return;
    }
    if (Node.isVariableDeclaration(node) && node.getName() === functionName) {
      const initializer = node.getInitializer();
      if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        found = pattern.test(initializer.getText());
      }
    }
  });
  return found;
}

function functionBodyHasSentry(source: SourceFile, functionName: string): boolean {
  return functionBodyMatches(source, functionName, /Sentry\.(captureException|captureMessage)/);
}

function functionBodyHasAbortDetection(source: SourceFile, functionName: string): boolean {
  return functionBodyMatches(source, functionName, /AbortError|isTimeout/);
}

/**
 * AST-scoped check: traverse try-catch statements and identify catch blocks
 * that handle timeout/abort errors, then verify those specific blocks contain
 * Sentry reporting -- either directly, or via a same-file helper function
 * call (see functionBodyHasSentry). Excludes comments and unrelated
 * adjacent catch blocks.
 */
function checkSentryInAbortCatch(source: SourceFile): boolean {
  let foundSentryInAbortCatch = false;

  source.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CatchClause) return;

    const catchClause = node;
    const catchBlock = catchClause.getBlock();
    if (!catchBlock) return;

    const catchText = catchBlock.getText();
    const calledNames = catchBlock.getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((call) => call.getExpression().getText())
      .filter((name) => /^[a-zA-Z_$][\w$]*$/.test(name)); // plain identifiers only, not member expressions like console.error

    // Check if this catch block mentions AbortError or isTimeout (the
    // abort/timeout path) -- either directly, or via a same-file helper it
    // delegates to (same one-level-of-indirection reasoning as the Sentry
    // check below: a helper can own BOTH the detection and the reporting).
    const isAbortRelated = /AbortError|isTimeout/.test(catchText)
      || calledNames.some((name) => functionBodyHasAbortDetection(source, name));
    if (!isAbortRelated) return;

    // Within this abort-related catch block, check for Sentry calls (ignoring comments)
    // Strip comments before checking
    const statements = catchBlock.getStatements().map(s => s.getText()).join('\n');
    if (/Sentry\.(captureException|captureMessage)/.test(statements)) {
      foundSentryInAbortCatch = true;
      return;
    }

    // No direct Sentry call -- check whether the catch block calls a
    // same-file helper that itself reports to Sentry.
    if (calledNames.some((name) => functionBodyHasSentry(source, name))) {
      foundSentryInAbortCatch = true;
    }
  });

  return foundSentryInAbortCatch;
}

export const StreamResilienceRule: Rule = {
  name: "stream-resilience-audit",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    const text = source.getText();

    // RCA (2026-09-29, PR #362): test files that SIMULATE a timed-out or
    // aborted stream (a mock ReadableStream + setTimeout + abort listener)
    // have no analysis state to settle, so they matched this rule by
    // construction. Same test-file exemption the reliability-lessons rules use.
    if (/(\.test|\.spec)\.[cm]?[tj]sx?$|(?:^|\/)__tests__\//.test(filePath)) return findings;

    // RCA (2026-07-24, PR #160 + post-merge follow-up): two compounding false-
    // positive sources.
    //
    // (a) The rule only recognized the WEB store's settlement vocabulary
    // (settleAnalysis/setError, from useSSEStream.ts's local closure) --
    // neither identifier can ever appear in a worker file, so this
    // unconditionally false-positived on every worker/**/*.ts file containing
    // any setTimeout+abort combo (e.g. analysis.ts's persist-retry timeout).
    // The worker's actual equivalent is emitting an SSE error frame --
    // recognize that pattern too.
    //
    // (b) The rule never confirmed the file is a client-facing stream
    // response handler in the first place -- ANY setTimeout+abort pairing
    // matched, including a plain bounded-fetch-with-timeout on a data
    // adapter (WorkerPromptConfigAdapter's Redis read has nothing to
    // "settle"; there's no stream response at all). "Settle error state"
    // only means something for an actual ReadableStream/SSE response, so
    // require that evidence before the setTimeout+abort check even applies.
    // (c) RCA (2026-07-30): a third legitimate settlement vocabulary --
    // a server-side (cron/webhook) consumer of an SSE stream that isn't the
    // web client (no settleAnalysis/setError, no UI state) and isn't the
    // worker emitting frames (no `send({type:"error"})`). It "settles" by
    // returning a typed failure result that its caller reports via Sentry
    // and tallies -- e.g. dimension-remediation.ts's collectDimensionsFromWorker
    // catches the AbortError, calls Sentry.captureException, and returns
    // null, which the caller turns into RemediationStage.WorkerFailed. A
    // Sentry report co-located with the abort/timeout catch is equally
    // valid evidence of "not silently left in limbo" as the other two forms.
    //
    // AST-scoped inspection (replaces previous file-wide text regex):
    // traverse try-catch blocks, identify timeout/abort-related catch blocks
    // by their body content, and check if those specific catch blocks contain
    // Sentry reporting. Excludes adjacent unrelated catch blocks and comments.
    const hasSentryReportNearAbort = checkSentryInAbortCatch(source);
    const isStreamResponseHandler = /ReadableStream|text\/event-stream|EventSource|\.getReader\(\)|response\.body/.test(text);
    const hasWorkerErrorFrame = /send\(\s*\{\s*type:\s*["']error["']/.test(text);

    if (isStreamResponseHandler && text.includes('setTimeout') && text.includes('abort') && !text.includes('settleAnalysis') && !text.includes('setError') && !hasWorkerErrorFrame && !hasSentryReportNearAbort) {
      findings.push({
        file: filePath,
        severity: "high",
        title: "Stream: Timeout abort does not settle error state",
        why: "Abort timeout fires but no error/complete state is set, leaving analysis in limbo.",
        fix: "Call settleAnalysis('error', ...) or setStreamError() when timeout fires, not just abort()."
      });
    }
    return findings;
  }
};

export const BundleContradictionRule: Rule = {
  name: "bundle-contradiction-detector",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const text = source.getText();
    const allDimensionsPattern = /All (?:\$\{TOTAL_DIMENSIONS\}|11) dimensions must be present/;
    if (allDimensionsPattern.test(text) &&
        text.includes('ONLY generate') &&
        !text.includes('skipAllDimensionsInstruction')) {
      findings.push({
        file: ctx.filePath.replace(/\\/g, "/"),
        severity: "critical",
        title: "Prompt: Contradictory instructions — 'all dims' + 'only these dims'",
        why: "LLM sees both 'All 11 dims' AND 'ONLY these dims'. LLM follows the first. The focus section is ignored.",
        fix: "Set skipAllDimensionsInstruction=true in getUCISPrompt() for bundle-scoped prompts."
      });
    }
    return findings;
  }
};

export const TranscriptGuardRule: Rule = {
  name: "transcript-guard-enforcer",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    const text = source.getText();
    const isEntryPoint = text.includes('app.post') || text.includes('app.get');
    if (isEntryPoint && (text.includes('analyze') || text.includes('stream')) && text.includes('transcript')) {
      const hasGuard = text.includes('transcript unavailable') || text.includes('TranscriptGuard') || text.includes('400');
      if (!hasGuard) {
        findings.push({
          file: filePath,
          severity: "critical",
          title: "Guard: LLM stream entry point without transcript check",
          why: "Entry point calls analyze/stream but doesn't check transcript validity. Costly LLM calls on placeholder data.",
          fix: "Check transcript before LLM call at the entry point. Return 400 if unavailable after all fetch attempts."
        });
      }
    }
    return findings;
  }
};

export const StreamSettleRule: Rule = {
  name: "stream-settle-audit",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    const text = source.getText();
    if (text.includes('Promise.all') && text.includes('completedIndexes') && filePath.includes('useSSEStream')) {
      if (!text.includes('streamController') && !text.includes('AbortController')) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "Stream: Parallel streams missing per-stream abort",
          why: "Parallel SSE streams without per-stream AbortController can hang on timeout.",
          fix: "Create per-stream AbortController, combine with parent via AbortSignal.any()."
        });
      }
    }
    return findings;
  }
};

export const CascadeOrderRule: Rule = {
  name: "cascade-order-enforcer",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    if (!filePath.includes('TranscriptExtractor')) return findings;
    const text = source.getText();
    const decodoIdx = text.indexOf('Decodo');
    const ytIdx = text.indexOf('fetchWithPrimary');
    if (decodoIdx !== -1 && ytIdx !== -1 && decodoIdx > ytIdx) {
      findings.push({
        file: filePath,
        severity: "high",
        title: "Cascade: Transcript fallback order wrong",
        why: "Agreed: Decodo→YouTube→proxy→graceful. YouTube-first fails without proxy.",
        fix: "Swap to Decodo primary, YouTube via Bright Data proxy as fallback."
      });
    }
    return findings;
  }
};

export const ProxyPromotionRule: Rule = {
  name: "proxy-promotion-audit",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    
    // Check wrangler.toml directly if scanned, or look for proxy URL patterns in TS code
    const text = source.getText();
    if (filePath.includes('wrangler.toml')) {
      if (text.includes('RESIDENTIAL_PROXY_URL') && !text.includes('wrangler secret put')) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "Config: Proxy credential documented but not deployed as secret",
          why: "RESIDENTIAL_PROXY_URL in wrangler.toml as comment. YouTube path silently fails without it.",
          fix: "Add 'wrangler secret put RESIDENTIAL_PROXY_URL' instruction. Required for YouTube timedtext API."
        });
      }
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      // If we see proxy configuration reference in TypeScript, ensure wrangler.toml exists and configures it,
      // or check that it's properly handled as a secret.
      const hasProxyReference = text.includes('RESIDENTIAL_PROXY_URL');
      const hasSecureAccess = text.includes('process.env.RESIDENTIAL_PROXY_URL') ||
                              text.includes('c.env.RESIDENTIAL_PROXY_URL') ||
                              text.includes('env.RESIDENTIAL_PROXY_URL');
      const isTypeDefinition = text.includes('RESIDENTIAL_PROXY_URL?: string') || text.includes('RESIDENTIAL_PROXY_URL: string');
      if (hasProxyReference && !hasSecureAccess && !isTypeDefinition) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "Config: Proxy URL accessed directly without env secret",
          why: "Hardcoded proxy URL patterns or raw references in TypeScript code violate secret hygiene.",
          fix: "Access RESIDENTIAL_PROXY_URL via process.env (Node.js) or c.env/env (Hono bindings)."
        });
      }
    }
    return findings;
  }
};

export const ModuleLevelDynamicImportRule: Rule = {
  name: "module-level-dynamic-import",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = ctx.filePath.replace(/\\/g, "/");
    if (!filePath.includes('.tsx') && !filePath.includes('.jsx')) return findings;

    const lines = source.getText().split(/\r?\n/);
    lines.forEach((line) => {
      const trimmed = line.trim();
      const importMatch = trimmed.match(/(?:const\s+\w+\s*=\s*)?import\(['"]/);
      if (!importMatch) return;

      const indent = line.search(/\S/);
      if (indent === 0) {
        const varMatch = trimmed.match(/const\s+(\w+)\s*=\s*import/);
        if (varMatch) {
          const varName = varMatch[1];
          const text = source.getText();
          const isUsedInHandler = text.includes(`await ${varName}`) && (
            text.includes('handleClick') || text.includes('handleAuth') || text.includes('handleSupabase') ||
            text.includes('onClick') || text.includes('onSubmit')
          );
          if (isUsedInHandler) {
            findings.push({
              file: filePath,
              severity: "high",
              title: "Auth: Module-level dynamic import breaks retry on failure",
              why: `import() assigned to ${varName} at module scope resolves once. If it fails, the promise rejects permanently. No retry possible. Also blocks paint if used in click handler.`,
              fix: `Move import() inside the handler function, or use a lazy getter: const getModule = () => import('@/module').then(m => m.default)`
            });
          }
        }
      }
    });
    return findings;
  }
};
