/**
 * Reliability rules mined from the 2026-09-24 false-negative wave
 * (external PR reviews #320/#321/#322 found defects qa-intel passed clean).
 *
 * Source entries: docs/qa-intel/RULESET_LESSONS_LEDGER.md (2026-09-24, R6/R7/R9/R11)
 * Real pre-fix snippets (verified at the actual PR head commits):
 * - R6/R7: cb5d1aa2 web/lib/admin-logs/fetchers.ts (`obsJson?.result?.events?.events || []`;
 *   observability fetch with no signal/timeout)
 * - R9: 92cb6a75 worker/src/routes/analysis.ts (Sentry.captureMessage on the
 *   non-2xx branch; sibling catch only console.warn)
 * - R11: 8c159c92 web/app/api/analyses/[id]/relations/route.ts:178
 *   (`if (insights.length > 0) { ...update... }`)
 */
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("__tests__/");
}

/** True if the expression contains a real optional-access link (`?.`), either
 * as a `?.` property access, `?.()` call, `?.[]` element access, or nested
 * within a member chain. AST-based, not textual, so ternaries like
 * `a ? b?.c : d` are attributed correctly. */
function hasOptionalAccess(expr: Node): boolean {
  if (Node.isPropertyAccessExpression(expr) || Node.isElementAccessExpression(expr)) {
    if (expr.hasQuestionDotToken()) return true;
    return hasOptionalAccess(expr.getExpression());
  }
  if (Node.isCallExpression(expr)) {
    if (expr.hasQuestionDotToken()) return true;
    return hasOptionalAccess(expr.getExpression());
  }
  if (Node.isNonNullExpression(expr)) return hasOptionalAccess(expr.getExpression());
  return false;
}

/** Root identifier of a member/call chain, e.g. `obsJson` for
 * `obsJson?.result?.events?.events`. Returns undefined for non-chain bases. */
function rootIdentifierOf(expr: Node): string | undefined {
  let current = expr;
  for (;;) {
    if (Node.isIdentifier(current)) return current.getText();
    if (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isCallExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isNonNullExpression(current) || Node.isAwaitExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return undefined;
  }
}

/** Root identifier NODE of a member/call chain — the actual Identifier node
 * (not just its text) so symbol resolution can distinguish shadowed names.
 * Returns undefined for non-chain bases. */
function findRootIdentifierNode(expr: Node): Node | undefined {
  let current = expr;
  for (;;) {
    if (Node.isIdentifier(current)) return current;
    if (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isCallExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isNonNullExpression(current) || Node.isAwaitExpression(current)) {
      current = current.getExpression();
      continue;
    }
    return undefined;
  }
}

/**
 * R6 — Silent default on an external response shape.
 *
 * `fetchedJson?.deep?.path || []` / `?? []` silently converts an unexpected
 * upstream shape (auth drift, renamed field, envelope change) into an empty
 * success — the exact PR #321 incident (`obsJson?.result?.events?.events ||
 * []` swallowed a real shape and returned 200 with zero entries).
 *
 * Scope guard (false-positive control): only fires when the chain's root
 * identifier resolves — via the type checker's symbol bindings, so shadowed
 * or unrelated same-name variables are NOT matched — to a local variable
 * whose initializer is an AST fetch/JSON boundary (`await fetch(...)`,
 * `x.json()`, `fetchWithTimeout(...)`) or a simple alias of one
 * (`const payload = json`). Comments and string literals mentioning
 * `.json()`/`fetch(` are ignored (AST-based detection, not textual).
 * Internal optional data (`store?.items ?? []`, props/params) is not flagged.
 */
export const SilentDefaultOnExternalResponseRule: Rule = {
  name: "silent-default-on-external-response-shape",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    /** VariableDeclaration nodes whose initializer is a fetch/JSON boundary. */
    const fetchedDecls = new Set<Node>();
    /** Map of alias declaration node -> initializer Identifier node. */
    const aliasInits = new Map<Node, Node>();

    source.forEachDescendant((node) => {
      if (!Node.isVariableDeclaration(node)) return;
      let init = node.getInitializer();
      if (!init) return;
      if (Node.isAwaitExpression(init)) init = init.getExpression();
      if (Node.isIdentifier(init)) {
        aliasInits.set(node, init);
        return;
      }
      if (Node.isCallExpression(init)) {
        const expr = init.getExpression();
        // `.json()` boundary: last property access in the callee chain.
        if (Node.isPropertyAccessExpression(expr) && expr.getName() === "json") {
          fetchedDecls.add(node);
          return;
        }
        const calleeText = expr.getText();
        if (calleeText === "fetch" || calleeText === "globalThis.fetch") {
          fetchedDecls.add(node);
          return;
        }
        if (calleeText === "fetchWithTimeout") {
          fetchedDecls.add(node);
          return;
        }
      }
    });

    if (fetchedDecls.size === 0) return findings;

    /** Resolve an identifier to a fetched-root declaration, following alias
     * initializers transitively (depth-capped) and honoring symbol bindings
     * so a shadowed same-name variable does not resolve to the outer root. */
    const resolvesToFetched = (ident: Node, depth = 0): boolean => {
      if (depth > 4) return false;
      const decls = ident.getSymbol()?.getDeclarations() ?? [];
      for (const decl of decls) {
        if (fetchedDecls.has(decl)) return true;
        const aliasInit = aliasInits.get(decl);
        if (aliasInit && resolvesToFetched(aliasInit, depth + 1)) return true;
      }
      return false;
    };

    source.forEachDescendant((node) => {
      if (!Node.isBinaryExpression(node)) return;
      const op = node.getOperatorToken().getText();
      if (op !== "||" && op !== "??") return;
      const rhs = node.getRight();
      if (!Node.isArrayLiteralExpression(rhs)) return;
      if (rhs.getElements().length !== 0) return;
      const lhs = node.getLeft();
      if (!hasOptionalAccess(lhs)) return;
      const root = rootIdentifierOf(lhs);
      if (!root) return;
      const rootIdent = findRootIdentifierNode(lhs);
      if (!rootIdent || rootIdent.getText() !== root || !resolvesToFetched(rootIdent)) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: `Reliability: silent empty-default on fetched response shape ('${root}')`,
        why: `'${node.getText()}' defaults an optionally-chained read of a fetched response (${root} resolves to a fetch/.json() boundary) to an empty array. An upstream shape change, auth drift or error envelope silently becomes an empty success instead of surfacing.`,
        fix: "Validate the response shape explicitly (Zod schema, or explicit checks that throw/log a warning with the raw shape) before defaulting; never turn an unknown shape into an empty success.",
      });
    });

    return findings;
  },
};

/**
 * True when the `signal:` value provably enforces a deadline. Only bounded
 * patterns count (PR #335 review): `AbortSignal.timeout(n)`,
 * `AbortSignal.any([...])` containing a bounded element, or an
 * AbortController whose `signal` is wired to a `setTimeout(...abort...)`
 * in the same enclosing function scope. A bare `signal: undefined`,
 * an untraceable spread, or a never-aborted controller does NOT count —
 * those recreate the exact "no deadline" bug this rule guards against.
 */
function controllerHasBoundedTimeout(controllerId: string, from: Node): boolean {
  let scope: Node | undefined = from;
  while (scope && !Node.isFunctionDeclaration(scope) && !Node.isMethodDeclaration(scope) &&
         !Node.isArrowFunction(scope) && !Node.isFunctionExpression(scope)) {
    scope = scope.getParent();
  }
  if (!scope) scope = from.getSourceFile();
  const abortRe = new RegExp(`\\b${controllerId}\\s*\\.\\s*abort\\b`);
  return scope.getDescendants().some((d) => {
    if (!Node.isCallExpression(d) || d.getExpression().getText() !== "setTimeout") return false;
    return d.getArguments().some((a) => abortRe.test(a.getText()));
  });
}

function signalExprIsBounded(expr: Node): boolean {
  const text = expr.getText();
  if (text === "undefined" || text === "null") return false;
  if (/^AbortSignal\.timeout\s*\(/.test(text)) return true;
  // AbortSignal.any([...]) — bounded iff at least one element is bounded.
  if (Node.isCallExpression(expr) && /^AbortSignal\.any/.test(text)) {
    const first = expr.getArguments()[0];
    if (first && Node.isArrayLiteralExpression(first)) {
      return first.getElements().some((el) => {
        const elText = el.getText();
        if (/^AbortSignal\.timeout\s*\(/.test(el.getText())) return true;
        const m = /^([\w$.]+)\.signal$/.exec(el.getText());
        return m ? controllerHasBoundedTimeout(m[1], expr) : false;
      });
    }
    return /^AbortSignal\.timeout/.test(text);
  }
  // controller.signal — bounded only if the controller is aborted via
  // setTimeout somewhere in the same enclosing function/file scope.
  const m = /^([\w$.]+)\.signal$/.exec(text);
  if (m) return controllerHasBoundedTimeout(m[1], expr);
  return false;
}

/**
 * R7 — Server-side fetch without a timeout/AbortSignal.
 *
 * The PR #321 second Cloudflare call had no timeout: one hung upstream
 * request held the whole admin route open despite the "fail-soft" intent,
 * violating the project's dual-timeout convention (CLAUDE.md Law #2).
 *
 * Scope: server-side files only (web/app/api/**, worker/src/**, and the
 * server-only web/lib/admin-logs/**). Client components/hooks legitimately
 * stream long responses and are NOT flagged. A `signal:` option only counts
 * as a timeout when it is a BOUNDED pattern: `AbortSignal.timeout(n)`,
 * `AbortSignal.any([...timeout...])`, or a controller with a
 * `setTimeout(...abort(...))` in the same scope (e.g. the fetchers.ts
 * `setTimeout(() => controller.abort(), QSTASH_LOGS_TIMEOUT_MS)` idiom).
 * `signal: undefined` or a never-aborted controller still fires. Calls
 * through known bounded wrappers (`fetchWithTimeout`, web/lib/utils/fetch-with-timeout.ts)
 * are safe.
 */
export const ServerFetchWithoutTimeoutRule: Rule = {
  name: "server-fetch-without-timeout",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    const SERVER_PREFIXES = ["web/app/api/", "worker/src/", "web/lib/admin-logs/"];
    const isServerSide = SERVER_PREFIXES.some((p) => filePath.startsWith(p) || filePath.includes(`/${p}`));
    if (!isServerSide) return findings;

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const callee = node.getExpression().getText();
      // Only the real global `fetch` — a `something.fetch(...)` domain-method
      // wrapper (TranscriptExtractor.fetch, MetadataScraper.fetch, …) manages
      // its own internal timeouts/retries and is out of scope; same for
      // `fetchWithTimeout(...)` which does not textually match `fetch` anyway.
      const isPlainFetch = callee === "fetch" || callee === "globalThis.fetch";
      if (!isPlainFetch) return;

      const callText = node.getText();
      // Only a BOUNDED signal counts as a timeout. Top-level argument object
      // literals only (nested/inner fetch must not double-match).
      const hasBoundedSignal = node.getArguments().some((arg) => {
        if (!Node.isObjectLiteralExpression(arg)) return false;
        return arg.getProperties().some((prop) => {
          if (Node.isPropertyAssignment(prop)) {
            if (prop.getNameNode().getText() !== "signal") return false;
            return signalExprIsBounded(prop.getInitializer());
          }
          if (Node.isShorthandPropertyAssignment(prop)) {
            if (prop.getName() !== "signal") return false;
            // `signal` shorthand: value is a variable; only bounded if it
            // resolves to a bounded pattern — untraceable, so not accepted.
            return false;
          }
          // Spread assignments carry an unknown signal — not provably bounded.
          return false;
        });
      });
      if (hasBoundedSignal) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: "Reliability: server-side fetch without timeout/AbortSignal",
        why: `A server-side call (${callText.slice(0, 120)}${callText.length > 120 ? "…" : ""}) has no 'signal' option. A hung upstream connection blocks this server context indefinitely — outside fetchWithTimeout there is no deadline (dual-timeout Law #2).`,
        fix: "Pass an AbortController signal with a bounded timeout (or use the project's fetchWithTimeout helper), and clearTimeout in a finally block.",
      });
    });

    return findings;
  },
};

/** AST-based Sentry capture detection: a real `Sentry.capture*` CALL, never a
 * comment or string literal (both are excluded by node-kind inspection). */
function isSentryCaptureCall(node: Node): boolean {
  return Node.isCallExpression(node) && node.getExpression().getText().startsWith("Sentry.capture");
}

/** True if `node` sits inside a nested function (arrow/function expression/
 * declaration/method) whose enclosing scope is strictly INSIDE `outer` — e.g.
 * a Sentry capture inside a `.map(() => ...)` or `setTimeout(() => ...)`
 * callback within a try block runs in a DIFFERENT execution branch than the
 * try's own failure path, so it is not sibling asymmetry. */
function isInsideNestedFunctionOf(node: Node, outer: Node): boolean {
  let current = node.getParent();
  while (current && current !== outer) {
    if (Node.isFunctionDeclaration(current) || Node.isFunctionExpression(current) ||
        Node.isArrowFunction(current) || Node.isMethodDeclaration(current)) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

/**
 * R9 — Error-path asymmetry.
 *
 * The PR #320 incident: the non-2xx branch captured to Sentry, but the
 * sibling `catch` (network/timeout/DNS — the MORE common failure class) only
 * console.warn'd, so a real auth regression ran for weeks with zero alerting
 * signal.
 *
 * Fires on a catch block that logs only via console.* (no Sentry, no rethrow)
 * when the same enclosing function already contains a Sentry.capture* call
 * — i.e., the function clearly has an established telemetry convention that
 * this path silently drops.
 */
export const ErrorPathAsymmetryRule: Rule = {
  name: "error-path-telemetry-asymmetry",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    source.forEachDescendant((node) => {
      if (!Node.isCatchClause(node)) return;
      const body = node.getBlock();
      const bodyText = body.getText();
      const hasConsoleLog = /console\.(warn|error|log)\(/.test(bodyText);
      if (!hasConsoleLog) return;
      // AST-based: a real Sentry.capture* CALL in the catch body (comments and
      // string literals are node kinds, not call expressions, so explanatory
      // text like "Sentry.captureException would double-report" can't mask it).
      if (body.getDescendants().some(isSentryCaptureCall)) return;
      if (/\bthrow\b/.test(bodyText)) return; // error is re-raised upstream, not swallowed

      // The asymmetry must be BETWEEN SIBLING BRANCHES OF THE SAME try — the
      // exact PR #320 shape: try { if (!ok) Sentry.captureMessage(...) }
      // catch (err) { console.warn(...) }. A Sentry capture elsewhere in the
      // file/function is NOT asymmetry: deliberate console-only best-effort
      // paths (middleware auth-diag, Redis fail-soft getters, retry-loop
      // intermediates with a terminal Sentry capture after exhaustion) are an
      // established convention, not the bug.
      const tryStmt = node.getFirstAncestorByKind(SyntaxKind.TryStatement);
      if (!tryStmt) return;
      // Same-try sibling only, AND in the try's direct flow: a Sentry capture
      // inside a nested function in the try block (a .map(() => ...) or
      // setTimeout(() => ...) callback) is a different execution branch, not
      // the asymmetry the rule targets.
      const hasSiblingSentryCapture = tryStmt
        .getTryBlock()
        .getDescendants()
        .some((d) => isSentryCaptureCall(d) && !isInsideNestedFunctionOf(d, tryStmt.getTryBlock()));
      if (!hasSiblingSentryCapture) return;

      // Do not double-flag nested catches when the outer function body
      // already produced a finding for an outer catch.
      const caught = node.getVariableDeclaration()?.getText() ?? "error";
      findings.push({
        file: filePath,
        severity: "medium",
        title: "Reliability: sibling catch logs console-only while the same function captures to Sentry",
        why: `This catch ('${caught}') only console-warns, while other failure paths in the same function capture to Sentry. Failure classes that land in the catch (network/timeout/parse) get zero alerting signal — the exact PR #320 gap (non-2xx → Sentry, catch → console.warn for weeks).`,
        fix: "Capture this catch's error to Sentry too (Sentry.captureException/captureMessage with operation tags), matching the function's other failure branches.",
      });
    });

    return findings;
  },
};

/**
 * R11 — Success-guarded persistence.
 *
 * `if (result.length > 0) { persist(result) }` treats a valid empty
 * computed result as "nothing to save", so the cache/DB row never exists and
 * every subsequent request recomputes (PR #322: `if (insights.length > 0)`
 * around the stance-relations write-through → paid recompute on every cache
 * expiry for legitimately-empty results).
 *
 * INTENDED SCOPE (documented per PR #335 review — the rule is deliberately
 * narrow, not a general "guard" detector):
 * - Supported predicates: `x.length > 0` AND the truthiness variant
 *   `if (x.length)` (same semantic: empty result treated as "skip write").
 * - Supported sinks (write-through shapes where persisting the EMPTY result
 *   itself is the correct terminal state): a Supabase `.update(...)` chain
 *   and the project's `setRedisValue(...)` helper.
 * - NOT flagged (deliberate): `.insert(...)` guarded on non-empty (legitimate
 *   empty-batch skip — there is genuinely nothing to insert), reads, deletes,
 *   and any other sink.
 *
 * False-positive control: fires only on the write-through shapes above.
 */
export const SuccessGuardedPersistenceRule: Rule = {
  name: "success-guarded-persistence",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    source.forEachDescendant((node) => {
      if (!Node.isIfStatement(node)) return;
      const condText = node.getExpression().getText().trim();
      const condMatch = /^([\w$.]+)\.length(?:\s*>\s*0)?$/.exec(condText);
      if (!condMatch) return;
      const thenText = node.getThenStatement().getText();
      const isWriteThrough = /\.update\(/.test(thenText) || /setRedisValue\(/.test(thenText);
      if (!isWriteThrough) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: `Reliability: persistence skipped on empty result ('${condText}')`,
        why: `An .update()/Redis write-through is gated on '${condText}'. A valid empty result skips the write, so no cached/persisted value ever exists for that state and every later request recomputes (PR #322: empty stance-relations → paid recompute on every cache expiry).`,
        fix: "Persist the empty result too (it is a valid terminal state), or add an explicit tombstone/negative-cache marker instead of skipping the write entirely.",
      });
    });

    return findings;
  },
};
