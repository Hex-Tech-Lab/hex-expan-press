import { Node } from "ts-morph";
import type { Scope } from "ts-morph";
import type { SourceFile, VariableDeclaration } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("__tests__/");
}

/**
 * ARTAS structural vectors (v3 rules, 2026-10-08) — Phase 2 QualityEngine arming.
 * Source: .memory/ARTAS_REGISTRY.md (32-vector v4 registry). Four
 * vectors marked [QE] get a static rule here; the rest stay review-only.
 * Each rule carries a positive-fire test on the historical incident shape and
 * a negative-control test on the fixed/safe shape; see
 * scripts/quality-engine/rules/__tests__/artas-rules.test.ts.
 */

const BODY_CONSUMERS = [".text()", ".json()", ".arrayBuffer()", ".blob()"];

function findEnclosingFunction(node: Node): Node | undefined {
  let cur: Node | undefined = node;
  while (cur) {
    if (
      Node.isFunctionDeclaration(cur) ||
      Node.isMethodDeclaration(cur) ||
      Node.isArrowFunction(cur) ||
      Node.isFunctionExpression(cur) ||
      Node.isConstructorDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.getParent();
  }
  return undefined;
}

/**
 * Functions that gate on the request method: a comparison of a method value
 * against 'GET' and 'HEAD' (`method === 'GET'`, `m !== "HEAD"`), or an
 * allowlist call such as `['GET', 'HEAD'].includes(method)`. Bare string
 * literals elsewhere (a log line, a comment-like string) no longer exempt the
 * function (V24 detector evasion, ARTAS sweep 2026-10-11).
 */
function textContainsBothGetAndHead(fn: Node): boolean {
  const text = fn.getText();
  const compares = (verb: string) =>
    new RegExp(`(?:\\bmethod\\w*|\\.method)\\s*(?:===|!==|==|!=)\\s*['"\`]${verb}['"\`]|['"\`]${verb}['"\`]\\s*(?:===|!==|==|!=)\\s*(?:\\w+\\.)?method`, "i").test(text);
  const allowlist = /\[\s*['"`](?:GET|HEAD)['"`]\s*,\s*['"`](?:GET|HEAD)['"`]\s*\]\s*\.includes\(/.test(text)
    || /new Set\(\s*\[\s*['"`](?:GET|HEAD)['"`]\s*,\s*['"`](?:GET|HEAD)['"`]\s*\]\s*\)/.test(text);
  return allowlist || (compares("GET") && compares("HEAD"));
}

/**
 * V20 — Unconsumed Stream Leak (.memory/ARTAS_REGISTRY.md Domain 5).
 * Historical incident: hex-expan fetch wrappers returned/threw on !res.ok
 * without cancelling the response body — the underlying connection (and its
 * socket + reader) leaked, eventually exhausting the runtime's connection
 * pool under retry load.
 *
 * AST pattern: inside a function containing a `fetch(...)` call, a
 * property-access check on the response variable (`res.ok` falsy-check via
 * `!res.ok` / `res.ok === false`, or `res.status` compared to a non-2xx
 * literal) whose *then-branch or throw expression* performs an early exit
 * (return/throw) with NO body cancellation/consumption anywhere in that
 * branch (`res.body?.cancel()`, `res.body.cancel()`, or a body-consumer call
 * `.text()/.json()/.arrayBuffer()/.blob()`).
 *
 * Accepted limitations: (1) a shared drain helper (`abort(res)`) is not
 * recognized and will fire; (2) status checks via a pre-stored variable
 * (`const ok = res.ok`) are not traced; (3) consumption *before* the branch
 * suppresses the finding — but consumption after an `await` racing the
 * check is out of static reach.
 */
export const UnconsumedStreamLeakRule: Rule = {
  name: "artas-v20-unconsumed-stream",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;

    const reported = new Set<number>();

    source.forEachDescendant((node) => {
      if (!Node.isIfStatement(node)) return;
      const cond = node.getExpression().getText().replace(/\s+/g, "");
      // !res.ok / res.ok === false / res.ok !== true, or res.status compared to a non-2xx literal
      const negatedOk = /^!\w+(\?\.)?\??\.?ok$/.test(cond) || /^\w+(\?\.)?\??\.?ok===false$/.test(cond);
      const badStatus = /^\w+(\?\.)?\??\.?status(!==|===)(4|5)\d\d/.test(cond);
      if (!negatedOk && !badStatus) return;

      const fn = findEnclosingFunction(node);
      if (!fn) return;
      const fnText = fn.getText();
      if (!/\bfetch\s*\(/.test(fnText)) return;

      const thenText = node.getThenStatement()?.getText() ?? "";
      const isEarlyExit = /\b(return|throw)\b/.test(thenText);
      if (!isEarlyExit) return;

      const consumes =
        /\.body\??\.cancel\(\)/.test(thenText) ||
        BODY_CONSUMERS.some((c) => thenText.includes(c)) ||
        /\bawait\s+\w+(\?\.)?body\b/.test(thenText);
      if (consumes) return;

      // Body already consumed BEFORE the branch (e.g. `await res.json()` on
      // the happy path, then `if (!data.ok) throw`) — the body is not leaking;
      // the early exit rides on an already-parsed payload.
      const preText = fnText.slice(0, node.getStart() - fn.getStart());
      if (BODY_CONSUMERS.some((c) => preText.includes(c))) return;
      if (/\bawait\s+\w+(\?\.)?body\b/.test(preText)) return;

      const key = node.getStart();
      if (reported.has(key)) return;
      reported.add(key);
      findings.push({
        file: filePath,
        severity: "medium",
        title: "ARTAS V20: response body not cancelled on early-exit path",
        why: `${cond} branch returns/throws without cancelling or consuming the response body — the underlying connection/socket leaks (ARTAS_REGISTRY V20; hex-expan fetch wrappers leaked connections on every non-OK response).`,
        fix: "Call `res.body?.cancel()` (or drain via .text()/.json()) before returning/throwing on the error path.",
      });
    });

    return findings;
  },
};

/**
 * V10 — SSRF Exhaustion / unbounded body read (.memory/ARTAS_REGISTRY.md Domain 3).
 * Historical incident: hex-expan ExpanPress buffered a fetched document whole
 * with `res.arrayBuffer()` with no byte cap — a large or endless body could
 * exhaust memory (and the fetch target was user-influenced, compounding into
 * SSRF-driven resource exhaustion).
 *
 * AST pattern: a call `.arrayBuffer()` on a response expression, inside a
 * function with NO byte-limit evidence earlier in the same function body —
 * i.e. no `content-length` header read compared to a number and no reader
 * loop carrying a byte counter. Hard-coded allowlisted-host URL reads are exempt
 * only when trivially determinable (the fetch URL argument is a string
 * literal or template literal with no substitutions); any other case accepts
 * the hit.
 *
 * Accepted limitations: (1) byte caps enforced downstream (e.g. by a shared
 * `fetchLimited()` wrapper) are invisible — the call still fires; (2) only
 * `.arrayBuffer()` is matched (`.text()`/`.json()` buffered reads are the
 * same risk but appear across the codebase with separate review history;
 * this stays a review-only note); (3) flow analysis is absent — a limit
 * check in a helper is not recognized.
 */
export const UnboundedBodyReadRule: Rule = {
  name: "artas-v10-unbounded-body-read",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;

    const reported = new Set<number>();
    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      if (expr.getName() !== "arrayBuffer") return;

      const fn = findEnclosingFunction(node);
      // Top-level module code: no enclosing function — conservatively flag.
      const fnText = fn ? fn.getText() : source.getText();

      // Hard-coded URL exemption (trivially determinable): the function is
      // exempt if ANY fetch call in it has a pure string/template literal URL
      // (no substitutions) on an allowlisted host: youtube, ytimg, google,
      // supabase.
      const fetchCalls = fn
        ? fn.getDescendants().filter((d): d is import("ts-morph").CallExpression => {
            if (!Node.isCallExpression(d)) return false;
            const callee = d.getExpression();
            return Node.isIdentifier(callee) && callee.getText() === "fetch";
          })
        : [];
      let triviallyFirstParty = false;
      for (const fc of fetchCalls) {
        const arg = fc.getArguments()[0]?.getText() ?? "";
        const isPureLiteral =
          Node.isStringLiteral(fc.getArguments()[0] as Node) ||
          (Node.isNoSubstitutionTemplateLiteral(fc.getArguments()[0] as Node) ?? false);
        if (isPureLiteral && /https:\/\/[a-z0-9.-]*(youtube|ytimg|google|supabase)\./i.test(arg)) {
          triviallyFirstParty = true;
        }
      }
      if (triviallyFirstParty) return;

      // Byte-limit evidence anywhere in the enclosing function: a
      // content-length header read (compared to a number anywhere on the
      // same line / nearby comparison) or a counted reader loop.
      const hasContentLengthCap = /content-length/i.test(fnText) && /[><]=?\s*\d/.test(fnText);
      const hasByteCounter = /(byteCount|bytesRead|bytes)\s*[+]=/.test(fnText);
      if (hasContentLengthCap || hasByteCounter) return;

      const key = node.getStart();
      if (reported.has(key)) return;
      reported.add(key);
      findings.push({
        file: filePath,
        severity: "medium",
        title: "ARTAS V10: response body buffered whole without a byte cap",
        why: `${node.getExpression().getText()}() buffers the entire response in memory with no content-length check or counted reader loop — a large/endless body exhausts the runtime (ARTAS_REGISTRY V10; hex-expan ExpanPress arrayBuffer bypass).`,
        fix: "Check content-length against a cap before reading, or stream with a byte-counted reader loop; never buffer a user-influenced body whole.",
      });
    });

    return findings;
  },
};

/**
 * V19 — Idempotent Retry gate (.memory/ARTAS_REGISTRY.md Domain 4).
 * Historical incident: hex-expan's skew-retry-fetch wrapper retried every
 * method on transport failure, replaying POST/PUT/PATCH/DELETE mutations —
 * duplicate writes/order placements (ADR-0059).
 *
 * AST pattern: a loop (ForStatement / ForOfStatement / ForInStatement /
 * WhileStatement / DoStatement) or a recursive-retry function whose body
 * contains a `fetch(...)` call, where the enclosing function has NO reference
 * to both `'GET'` and `'HEAD'` (method gate) and no `idempotency` /
 * `Idempotency-Key` text anywhere. Severity high — replaying a mutation is
 * the direct historical failure.
 *
 * Accepted limitations: (1) the method gate is text-based over the enclosing
 * function — a gate in a callee (`assertIdempotent(method)`) is invisible;
 * (2) recursive retries are detected via the function's own-name recursion
 * heuristic, which misses mutual recursion; (3) fetch wrappers delegating to
 * `fetch` through a helper variable are recognized only when the callee text
 * contains `fetch`.
 */
export const NonIdempotentRetryRule: Rule = {
  name: "artas-v19-non-idempotent-retry",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;

    const reported = new Set<number>();

    const functionHasFetch = (fn: Node): boolean =>
      fn.getDescendants().some((d) => {
        if (!Node.isCallExpression(d)) return false;
        const callee = d.getExpression();
        return /fetch/.test(callee.getText());
      });

    source.forEachDescendant((node) => {
      if (
        !Node.isForStatement(node) &&
        !Node.isForOfStatement(node) &&
        !Node.isForInStatement(node) &&
        !Node.isWhileStatement(node) &&
        !Node.isDoStatement(node)
      ) {
        return;
      }
      const calls = node.getDescendants().filter((d) => {
        if (!Node.isCallExpression(d)) return false;
        return /fetch/.test(d.getExpression().getText());
      });
      if (calls.length === 0) return;

      const fn = findEnclosingFunction(node);
      if (!fn) return;
      if (textContainsBothGetAndHead(fn)) return;
      if (/idempotency/i.test(fn.getText())) return;

      const key = node.getStart();
      if (reported.has(key)) return;
      reported.add(key);
      findings.push({
        file: filePath,
        severity: "high",
        title: "ARTAS V19: fetch inside a retry loop without a GET/HEAD method gate",
        why: `A retry/backoff loop calls fetch with no method gate ('GET'/'HEAD') or idempotency key anywhere in the enclosing function — a transport failure after the server received a POST/PUT/PATCH/DELETE replays the mutation (ARTAS_REGISTRY V19; hex-expan skew-retry-fetch replayed mutations, ADR-0059).`,
        fix: "Gate the retry on method === 'GET' || method === 'HEAD' (or send an Idempotency-Key and make the endpoint dedupe); never blind-retry mutating requests.",
      });
    });

    // Recursive-retry heuristic: a function that calls fetch and calls itself.
    source.forEachDescendant((node) => {
      if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node) && !Node.isArrowFunction(node)) return;
      const name = Node.isFunctionDeclaration(node)
        ? node.getName()
        : Node.isMethodDeclaration(node)
          ? node.getName()
          : undefined;
      if (!name) return;
      const selfCalls = node.getDescendants().filter((d) => {
        if (!Node.isCallExpression(d)) return false;
        const callee = d.getExpression();
        return Node.isIdentifier(callee) && callee.getText() === name;
      });
      if (selfCalls.length === 0) return;
      if (!functionHasFetch(node)) return;
      if (textContainsBothGetAndHead(node)) return;
      if (/idempotency/i.test(node.getText())) return;
      const key = node.getStart();
      if (reported.has(key)) return;
      reported.add(key);
      findings.push({
        file: filePath,
        severity: "high",
        title: "ARTAS V19: recursive fetch retry without a GET/HEAD method gate",
        why: `A recursive retry function (${name}) calls fetch and re-invokes itself with no method gate ('GET'/'HEAD') or idempotency key — a transport failure after the server received a mutating request replays it (ARTAS_REGISTRY V19; hex-expan skew-retry-fetch, ADR-0059).`,
        fix: "Gate the retry on method === 'GET' || method === 'HEAD' (or send an Idempotency-Key); never blind-retry mutating requests.",
      });
    });

    return findings;
  },
};

/**
 * V05 — Fail-Open Undefined filter value (.memory/ARTAS_REGISTRY.md Domain 1).
 * Historical incident: `get_temporal_subgraph` built a query whose filter
 * value could be `null`, inferring service-role access from
 * `auth.uid() IS NULL` — a fail-open IDOR.
 *
 * AST pattern: a Supabase/PostgREST filter call
 * `.eq|.neq|.in|.match|.filter|.contains(col, value)` whose value argument is
 * (a) a TypeScript-typed expression whose type includes `undefined` or
 * `null` (when the checker is available), or (b) — fallback — an identifier
 * that is a parameter declared optional (`?:`) or typed `| undefined`/`| null`,
 * with NO preceding null guard on the identifier (`if (!x)`, `if (x == null)`,
 * `if (x != null)`, `if (x === undefined)`, `x ?? ...`) in the same function.
 * Severity high — a null/undefined filter value can make the filter
 * degenerate and return rows that should have matched nothing (unverified
 * against current supabase-js/PostgREST; see the rule's `why`).
 *
 * Accepted limitations: (1) the type-checker path depends on the Project
 * being created with real tsconfig; in the engine's in-memory/AST-only mode
 * only the syntactic fallback (optional/undefined-typed parameter) fires;
 * (2) guards in a caller (the value guaranteed non-null upstream) are not
 * tracked — no flow analysis; (3) destructured parameters fall back to
 * syntax-only detection.
 */
export const FailOpenUndefinedFilterRule: Rule = {
  name: "artas-v05-fail-open-filter",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;
    if (filePath.includes("/quality-engine/")) return findings;

    const FILTER_METHODS = new Set(["eq", "neq", "in", "match", "filter", "contains"]);
    const reported = new Set<number>();

    /** Syntactic "maybe undefined/null" fallback: parameter declared `?:` or typed `| undefined`/`| null`. */
    const isSyntacticallyOptionalIdentifier = (ident: string, scope: Node | undefined): boolean => {
      let hit = false;
      (scope ?? source).forEachDescendant((n) => {
        if (!Node.isParameterDeclaration(n)) return;
        if (n.getName() !== ident) return;
        if (n.isOptional()) {
          hit = true;
          return;
        }
        const t = n.getTypeNode()?.getText() ?? "";
        if (/\|\s*(undefined|null)\b/.test(t)) hit = true;
      });
      return hit;
    };

    /** A null guard on `ident` that appears before the filter call (a later check cannot protect a query that already ran). */
    const hasGuardBefore = (fn: Node | undefined, ident: string, callStart: number): boolean => {
      const scope = fn ?? source;
      const text = source.getFullText().slice(scope.getStart(), callStart);
      const id = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(
        `if\\s*\\(\\s*!\\s*${id}\\b|if\\s*\\(\\s*${id}\\s*==+\\s*(null|undefined)|${id}\\s*\\?\\?`,
      ).test(text);
    };

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) return;
      const method = callee.getName();
      if (!FILTER_METHODS.has(method)) return;
      const args = node.getArguments();
      // .eq(col, value) — value is the 2nd arg. .match({...}) takes an object: skip.
      if (method === "match" || args.length < 2) return;
      // .filter(col, operator, value): the value is the 3rd argument.
      const valueArg = method === "filter" ? args[2] : args[1];
      if (!valueArg) return;
      // Unwrap a single-element array literal: .in("col", [userId])
      const inner = Node.isArrayLiteralExpression(valueArg) && valueArg.getElements().length === 1
        ? valueArg.getElements()[0]!
        : valueArg;
      if (!Node.isIdentifier(inner)) return;
      const ident = inner.getText();

      let maybeNullish = false;
      // Type-checker path (works when ts-morph Project has a real program).
      try {
        const t = valueArg.getType();
        if (t.isNullable()) maybeNullish = true;
      } catch {
        // checker unavailable — fall through to syntax fallback
      }
      if (!maybeNullish && Node.isArrayLiteralExpression(valueArg)) {
        try {
          const el = valueArg.getElements()[0];
          if (el && el.getType().isNullable()) maybeNullish = true;
        } catch {
          /* checker unavailable */
        }
      }
      const fn = findEnclosingFunction(node);
      if (!maybeNullish && isSyntacticallyOptionalIdentifier(ident, fn)) maybeNullish = true;
      if (!maybeNullish) return;

      if (hasGuardBefore(fn, ident, node.getStart())) return;

      const key = node.getStart();
      if (reported.has(key)) return;
      reported.add(key);
      findings.push({
        file: filePath,
        severity: "high",
        title: "ARTAS V05: query filter value can be undefined/null (fail-open)",
        why: `.${method}('${callee.getExpression().getText()}', ${ident}) receives a value typed as possibly undefined/null with no preceding null guard — when the value is missing the filter degenerates instead of matching nothing (ARTAS_REGISTRY V05; get_temporal_subgraph auth.uid() IS NULL fail-open IDOR).`,
        fix: "Guard the value before the query (throw/return when undefined/null), or fail closed by constructing a never-matching predicate — never pass a possibly-nullish value into a filter.",
      });
    });

    return findings;
  },
};
