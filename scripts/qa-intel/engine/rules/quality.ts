import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding, IRule } from "../engine";

export const AsyncWithoutAwaitRule: IRule = {
  name: "async-without-await-detector",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    source.forEachDescendant((node) => {
      if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        // Check if function is async
        const isAsync = node.getModifiers().some(m => m.getKind() === SyntaxKind.AsyncKeyword);
        if (isAsync) {
          // Check if body contains any await
          const body = Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node)
            ? node.getBody()
            : (node as any).getBody?.();

          if (body) {
            const bodyText = body.getText();
            const hasAwait = bodyText.includes('await ');

            if (!hasAwait) {
              // Get function name for better reporting
              const funcName = (node as any).getName?.() || 'anonymous';
              findings.push({
                file: filePath,
                severity: "medium",
                title: `Code Quality: Redundant 'async' keyword (no await found)`,
                why: `Function '${funcName}' is marked async but contains no await expressions. This may indicate copy-paste or incomplete refactoring.`,
                fix: "Remove the 'async' keyword or add 'await' expression. If function returns a Promise, return it directly without 'async'."
              });
            }
          }
        }
      }
    });

    return findings;
  }
};

export const DeadCodeRule: IRule = {
  name: "dead-code-detector",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    try {
      source.forEachDescendant((node) => {
        try {
          // Detect unreachable if statements (always false conditions)
          if (Node.isIfStatement(node)) {
            try {
              const condition = node.getCondition?.();
              if (condition) {
                const condText = condition.getText().trim();
                // Check for obviously false conditions like !optionsSent when it's always true
                if (condText === 'false' || condText === '!true') {
                  findings.push({
                    file: filePath,
                    severity: "medium",
                    title: "Code Quality: Unreachable code block",
                    why: "If condition is always false, the entire block is unreachable dead code.",
                    fix: "Remove the unreachable if statement and its body."
                  });
                }
              }
            } catch {
              // Skip nodes without condition
            }
          }
        } catch {
          // Skip any node processing errors
        }
      });
    } catch {
      // Silently skip if any errors occur
    }

    return findings;
  }
};

export const VariableNamingRule: IRule = {
  name: "variable-naming-clarity",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    source.forEachDescendant((node) => {
      if (Node.isVariableDeclaration(node) || Node.isParameterDeclaration(node)) {
        const nameNode = node.getNameNode?.() || (node as any).getName?.();
        if (nameNode) {
          const name = typeof nameNode === 'string' ? nameNode : nameNode.getText?.() ?? '';

          // Flag single-letter variable names (except in loops or very short scopes)
          if (name.length === 1 && name !== 'i' && name !== 'j' && name !== 'x' && name !== 'y') {
            // Exempt a single-letter PARAMETER that is the sole parameter of
            // an arrow function passed directly as a callback argument to a
            // call expression -- e.g. `useFooStore((s) => s.bar)`,
            // `.map((x) => ...)`, `.then((r) => ...)`. This is a near-
            // universal functional idiom (Zustand/Redux selectors, array
            // methods, promise chains) across this codebase and the wider
            // ecosystem, not an unclear-naming case: the parameter's whole
            // referent is the single argument the call site already names.
            // (2026-09-10 fix: false-positived on `(s) => s.error` in this
            // exact codebase's own pervasive Zustand selector convention.)
            if (Node.isParameterDeclaration(node)) {
              const arrowFn = node.getParent();
              const callExpr = arrowFn?.getParent();
              if (
                Node.isArrowFunction(arrowFn) &&
                arrowFn.getParameters().length === 1 &&
                // A rest parameter (`(...q) => q.length`) also satisfies
                // `getParameters().length === 1`, but it represents a
                // variable-length collection, not the single callback value
                // this exemption is meant for -- it must still be flagged.
                // (2026-09-11 fix, external review on PR #307 finding #1.)
                !node.isRestParameter() &&
                Node.isCallExpression(callExpr) &&
                // Defensive guard: ensure the arrow is an ARGUMENT of the
                // call, not its callee. In practice the TS AST always wraps
                // an arrow-as-callee in a ParenthesizedExpression (so
                // `Node.isCallExpression(callExpr)` already excludes IIFEs
                // like `((q) => q.trim())()`), but this check is harmless
                // belt-and-suspenders against any AST shape where the arrow
                // somehow lands as the call's callee rather than an arg.
                // (2026-09-10, external review on PR #307 finding #2.)
                callExpr.getArguments().includes(arrowFn)
              ) {
                return;
              }
            }
            // Check if this is in a loop context
            let inLoop = false;
            let current = node.getParent();
            while (current) {
              if (Node.isForStatement(current) || Node.isForInStatement(current) || Node.isForOfStatement(current) || Node.isWhileStatement(current)) {
                inLoop = true;
                break;
              }
              current = current.getParent?.();
            }

            if (!inLoop) {
              findings.push({
                file: filePath,
                severity: "low",
                title: `Code Quality: Unclear variable name '${name}'`,
                why: `Single-letter variable '${name}' outside of loop context is unclear. Makes code harder to understand.`,
                fix: `Rename to a descriptive name that explains the variable's purpose (e.g., '${name}' → 'question', 'error', etc.).`
              });
            }
          }
        }
      }
    });

    return findings;
  }
};

export const TimeoutCleanupRule: IRule = {
  name: "timeout-cleanup-enforcer",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    // qa-intel's own rule tests embed deliberately-bad example code as
    // TEMPLATE-LITERAL TEXT to feed to the rule under test (e.g.
    // wave9-new-rules.test.ts's `const code = \`const timerId = setTimeout(...)\`\`)
    // -- a plain source.getText() scan can't distinguish that from real
    // executable code in the test file itself (review finding, 2026-09-07).
    if (filePath.includes('/quality-engine/') && (filePath.includes('.test.') || filePath.includes('__tests__/'))) {
      return findings;
    }
    const text = source.getText();

    // Look for setTimeout/setInterval without corresponding cleanup
    if (text.includes('setTimeout') || text.includes('setInterval')) {
      const timerPattern = /const\s+(\w+)\s*=\s*(?:setTimeout|setInterval)\s*\(/g;
      const matches = text.matchAll(timerPattern);

      for (const match of matches) {
        const handleName = match[1];
        // Check if this handle is cleared anywhere
        const isClearedRegex = new RegExp(`clearTimeout\\(${handleName}\\)|clearInterval\\(${handleName}\\)`);
        if (!isClearedRegex.test(text)) {
          findings.push({
            file: filePath,
            severity: "medium",
            title: `Resource Leak: Timer handle '${handleName}' not cleared`,
            why: `Variable '${handleName}' holds a timeout/interval ID but is never cleared. This can cause memory leaks or unintended side effects.`,
            fix: `Add cleanup in finally block or useEffect cleanup: clearTimeout(${handleName}); or clearInterval(${handleName});`
          });
        }
      }
    }

    return findings;
  }
};

export const ImportOrderingRule: IRule = {
  name: "import-ordering-enforcer",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    // Get all import declarations
    const imports = source.getImportDeclarations();
    if (imports.length < 2) return findings;

    const categories = {
      framework: [] as string[],       // react, next, etc.
      thirdparty: [] as string[],      // external packages
      internal: [] as string[],        // local imports starting with ./
      types: [] as string[]            // type-only imports
    };

    for (const imp of imports) {
      const specifier = imp.getModuleSpecifierValue();
      const isTypeOnly = imp.isTypeOnly();

      if (isTypeOnly) {
        categories.types.push(specifier);
      } else if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/')) {
        categories.internal.push(specifier);
      } else if (specifier === 'react' || specifier.startsWith('react') || specifier.startsWith('next') || specifier === 'zustand' || specifier.startsWith('@sentry')) {
        categories.framework.push(specifier);
      } else {
        categories.thirdparty.push(specifier);
      }
    }

    // Check ordering: should be framework → thirdparty → internal → types
    const order = ['framework', 'thirdparty', 'internal', 'types'] as const;
    let lastCategory = -1;

    for (const imp of imports) {
      const specifier = imp.getModuleSpecifierValue();
      const isTypeOnly = imp.isTypeOnly();

      let category: typeof order[number] = 'thirdparty';
      if (isTypeOnly) category = 'types';
      else if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/')) category = 'internal';
      else if (specifier === 'react' || specifier.startsWith('react') || specifier.startsWith('next') || specifier === 'zustand' || specifier.startsWith('@sentry')) category = 'framework';

      const currentCategoryIndex = order.indexOf(category);
      if (currentCategoryIndex < lastCategory) {
        findings.push({
          file: filePath,
          severity: "low",
          title: "Code Quality: Import ordering violated",
          why: `Import '${specifier}' (${category}) comes after ${order[lastCategory]}. Should follow order: framework → thirdparty → internal → types.`,
          fix: "Reorganize imports to follow the correct order groups."
        });
        break; // Report once per file
      }
      lastCategory = currentCategoryIndex;
    }

    return findings;
  }
};

export const ErrorObservabilityRule: IRule = {
  name: "error-observability-enforcer",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    source.forEachDescendant((node) => {
      // Look for catch blocks without logging/Sentry
      if (Node.isCatchClause(node)) {
        try {
          const block = node.getBlock();
          if (block) {
            const bodyText = block.getText();

            // Check if catch block contains any logging or Sentry
            const hasObservability = bodyText.includes('console.') || bodyText.includes('Sentry.') || bodyText.includes('logger.');

            if (!hasObservability && !bodyText.trim().startsWith('//')) {
              findings.push({
                file: filePath,
                severity: "medium",
                title: "Observability: Catch block without error logging",
                why: "Error is caught but not logged, making debugging difficult.",
                fix: "Add error logging: console.error('[context]', error); or Sentry.captureException(error);"
              });
            }
          }
        } catch {
          // Skip if API not available on this node
        }
      }

      // Look for try-catch-ignore patterns
      if (Node.isTryStatement(node)) {
        try {
          const catchClause = node.getCatchClause();
          if (catchClause) {
            const block = catchClause.getBlock();
            if (block) {
              const catchBody = block.getText();
              // Empty catch or just throw
              if (catchBody.trim() === '{}' || catchBody.trim() === '{ }') {
                findings.push({
                  file: filePath,
                  severity: "high",
                  title: "Observability: Empty catch block (silent failure)",
                  why: "Error is swallowed silently with no logging. Production issues will be invisible.",
                  fix: "Log the error or re-throw: catch (e) { console.error('[context]', e); throw e; }"
                });
              }
            }
          }
        } catch {
          // Skip if API not available on this node
        }
      }
    });

    return findings;
  }
};

// WAVE 10 rules (2026-09-11): mined from a retrospective sweep of 62 external
// review findings (Cubic/CodeRabbit/Sourcery) across 58 merged PRs, grouped
// into recurring bug classes. See docs/qa-intel/RETRO_WAVE_FINDINGS_2026-09-11.md
// for the full inventory and docs/qa-intel/RULESET_LESSONS_LEDGER.md for the
// per-rule inference notes. These three classes recurred (5, 5, 2 occurrences)
// and had no existing rule coverage.

export const ErrorNormalizationRule: IRule = {
  name: "error-normalization-enforcer",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    source.forEachDescendant((node) => {
      if (!Node.isCatchClause(node)) return;
      const param = node.getVariableDeclaration();
      if (!param) return;
      const caughtName = param.getName();
      const block = node.getBlock();
      if (!block) return;
      const bodyText = block.getText();

      // Only care about catch bodies that actually forward the caught value
      // somewhere observable (Sentry, console, thrown, or a template string).
      const forwardsRaw =
        new RegExp(`Sentry\\.[a-zA-Z]+\\(\\s*${caughtName}\\b`).test(bodyText) ||
        new RegExp(`console\\.[a-zA-Z]+\\([^)]*\\$\\{${caughtName}\\}`).test(bodyText) ||
        new RegExp(`throw\\s+${caughtName}\\b`).test(bodyText);

      if (!forwardsRaw) return;

      // A normalization guard looks like `X instanceof Error` or
      // `String(X)` / `X.message` appearing anywhere in the block, applied
      // to the caught variable before it's forwarded.
      const isNormalized =
        new RegExp(`${caughtName}\\s+instanceof\\s+Error`).test(bodyText) ||
        new RegExp(`String\\(\\s*${caughtName}\\s*\\)`).test(bodyText) ||
        new RegExp(`${caughtName}\\.message\\b`).test(bodyText) ||
        new RegExp(`${caughtName}\\.stack\\b`).test(bodyText);

      if (!isNormalized) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: `Code Quality: Catch variable '${caughtName}' forwarded without normalization`,
          why: `'${caughtName}' is caught as 'unknown' and passed to Sentry/console/rethrow without an 'instanceof Error' guard or 'String()' coercion. Non-Error throws (strings, objects) render as '[object Object]' or lose their stack trace. (2026-09-11, mined from PR #268/#234 external review findings.)`,
          fix: `Normalize before forwarding: const message = ${caughtName} instanceof Error ? ${caughtName}.message : String(${caughtName});`
        });
      }
    });

    return findings;
  }
};

export const NumberCoercionGuardRule: IRule = {
  name: "number-coercion-guard",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isIdentifier(expr) || expr.getText() !== "Number") return;

      const args = node.getArguments();
      if (args.length !== 1) return;
      const arg = args[0];
      const argText = arg.getText();

      // Skip obviously-safe cases: numeric/string literals, or an argument
      // already guarded by a typeof/nullish check earlier in the same
      // logical expression (e.g. `x != null ? Number(x) : fallback`).
      if (Node.isNumericLiteral(arg) || Node.isStringLiteral(arg)) return;

      const enclosingStatement = node.getFirstAncestor((a) =>
        Node.isVariableStatement(a) || Node.isExpressionStatement(a) || Node.isReturnStatement(a) || Node.isIfStatement(a)
      );
      const context = (enclosingStatement ?? node).getText();
      const hasGuard =
        context.includes(`typeof ${argText}`) ||
        context.includes(`${argText} != null`) ||
        context.includes(`${argText} !== null`) ||
        context.includes(`${argText} ??`) ||
        context.includes(`${argText} ?.`);

      if (!hasGuard) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: `Code Quality: Unguarded 'Number(${argText})' coercion`,
          why: `'Number(null)' silently returns 0 and 'Number(undefined)' returns NaN — both pass a naive range check and produce silent wrong behavior instead of a visible error. External data (API responses, DB columns, registry values) should be type-narrowed before coercion. (2026-09-11, mined from PR #268 external review findings: a null highlight offset silently became 0 instead of its intended 2.5s fallback.)`,
          fix: `Guard first: typeof ${argText} === 'number' || typeof ${argText} === 'string' ? Number(${argText}) : fallback`
        });
      }
    });

    return findings;
  }
};

export const UnregisteredRuleExportRule: IRule = {
  name: "unregistered-rule-export-detector",
  allowSelfAnalysis: true,
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");

    // Only applicable to files inside scripts/quality-engine/rules/ that
    // both export an IRule-typed const AND define a register*Rules function
    // — this is the exact shape of the 2026-09-07 incident where
    // AuthorizationRegexBypassRule was exported but never passed to
    // e.addRule(...) in registerSecurityRules, so it silently never ran.
    if (!filePath.includes("/scripts/quality-engine/rules/")) return findings;

    const ruleConstNames: string[] = [];
    source.forEachDescendant((node) => {
      if (!Node.isVariableDeclaration(node)) return;
      const typeNode = node.getTypeNode();
      if (typeNode?.getText() !== "IRule") return;
      ruleConstNames.push(node.getName());
    });

    if (ruleConstNames.length === 0) return findings;

    const registerFn = source.getFunctions().find((fn) => /^register[A-Za-z]*Rules$/.test(fn.getName() ?? ""));
    if (!registerFn) return findings; // this file doesn't define a registrar — nothing to check

    const registerBody = registerFn.getBodyText() ?? "";

    for (const ruleName of ruleConstNames) {
      const isRegistered = new RegExp(`addRule\\(\\s*${ruleName}\\b`).test(registerBody);
      if (!isRegistered) {
        findings.push({
          file: filePath,
          severity: "high",
          title: `Code Quality: Rule '${ruleName}' exported but not registered`,
          why: `'${ruleName}' is defined as an IRule in this file, but '${registerFn.getName()}' never calls 'e.addRule(${ruleName})'. The rule is dead code — it will never run against any PR. (2026-09-11, mined from the real 2026-09-07 incident: AuthorizationRegexBypassRule shipped unregistered and a live auth bypass went undetected.)`,
          fix: `Add 'e.addRule(${ruleName});' inside '${registerFn.getName()}'.`
        });
      }
    }

    return findings;
  }
};

/**
 * Register all quality-related rules with the QA-Intel engine.
 * Includes rules for async/await clarity, dead code detection, naming, timeouts,
 * import ordering, error observability, error normalization, number coercion
 * guards, and unregistered-rule detection (WAVE 10, 2026-09-11).
 * @param engine - The QA-Intel engine instance
 */
export function registerQualityRules(engine: unknown) {
  const e = engine as any;
  e.addRule(AsyncWithoutAwaitRule);
  e.addRule(DeadCodeRule);
  e.addRule(VariableNamingRule);
  e.addRule(TimeoutCleanupRule);
  e.addRule(ImportOrderingRule);
  e.addRule(ErrorObservabilityRule);
  e.addRule(ErrorNormalizationRule);
  e.addRule(NumberCoercionGuardRule);
  e.addRule(UnregisteredRuleExportRule);
}
