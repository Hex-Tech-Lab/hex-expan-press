import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export const HexagonalBoundaryRule: Rule = {
  name: "hexagonal-boundary-enforcer",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());
    const isAdapter = filePath.includes("/adapters/");

    if (!isAdapter) {
      source.forEachDescendant((node) => {
        if (Node.isCallExpression(node)) {
          const expression = node.getExpression();
          const text = expression.getText();
          if (text === "getSupabaseClient" || text.endsWith(".getSupabaseClient")) {
            findings.push({
              file: filePath,
              severity: "critical",
              title: "Boundary Violation: Direct Supabase Access",
              why: "Direct DB access outside of /adapters/ violates Hexagonal Lite architecture.",
              fix: "Move this logic into a dedicated Adapter port."
            });
          }
        }
      });
    }
    return findings;
  }
};

export const ComplexityRule: Rule = {
    name: "complexity-monitor",
    check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
      const findings: Finding[] = [];
      const filePath = normalizePosixPath(source.getFilePath());
      const lines = source.getText().split(/\r?\n/).length;
      if (lines > 500) {
        findings.push({
            file: filePath,
            severity: "medium",
            title: "Complexity: Monolithic File",
            why: `File exceeds 500 lines (${lines} lines).`,
            fix: "Decompose into smaller, domain-specific modules."
        });
      }
      return findings;
    }
};

export const ErrorTaxonomyRule: Rule = {
  name: "error-taxonomy-audit",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());

    source.forEachDescendant((node) => {
      if (Node.isIfStatement(node)) {
        const condition = node.getExpression().getText();
        if (condition.includes('error') && (condition.includes('!data') || condition.includes('!result'))) {
          const block = node.getThenStatement()?.getText() || '';
          if (block.includes('NotFound')) {
            findings.push({
              file: filePath,
              severity: "high",
              title: "Error Taxonomy: DB errors collapsed into NotFound",
              why: "Database/query errors are returned as NotFound, hiding real failures as missing resources.",
              fix: "Separate error cases: return 'InternalError' (-> 500) for query failures, 'NotFound' (-> 404) only when no rows match."
            });
          }
        }
      }
    });
    return findings;
  }
};

/** `x.split("\n")` with a single or double quoted LF separator. */
function isLfSplit(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "split") return false;
  const [separator] = call.getArguments();
  return separator !== undefined && Node.isStringLiteral(separator) && separator.getLiteralText() === "\n";
}

/** The split result is trimmed right away: `x.split("\n")[0].trim()` or `x.split("\n").map((l) => l.trim())`. */
function isTrimmedSplit(call: CallExpression): boolean {
  const parent = call.getParent();
  if (Node.isElementAccessExpression(parent)) {
    const access = parent.getParent();
    return Node.isPropertyAccessExpression(access) && access.getName() === "trim";
  }
  if (!Node.isPropertyAccessExpression(parent) || parent.getName() !== "map") return false;
  const mapCall = parent.getParent();
  return Node.isCallExpression(mapCall) && /\.trim\(\)/.test(mapCall.getArguments()[0]?.getText() ?? "");
}

/**
 * The text being split was built by this file (a literal, or a `.join(...)` result), so its line endings are known.
 * An interpolated template or a `let`/`var` can be reassigned to file text, so only a literal, a
 * substitution-free template, or a `const` initialised from one of those counts.
 */
function isSelfProducedText(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  let receiver: Node | undefined = callee.getExpression();
  if (Node.isIdentifier(receiver)) {
    const declaration = receiver.getSymbol()?.getValueDeclaration();
    const list = Node.isVariableDeclaration(declaration) ? declaration.getParent() : undefined;
    const isConst = Node.isVariableDeclarationList(list) && list.getDeclarationKind() === VariableDeclarationKind.Const;
    receiver = isConst && Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
  }
  if (!receiver) return false;
  if (Node.isStringLiteral(receiver) || Node.isNoSubstitutionTemplateLiteral(receiver)) return true;
  if (!Node.isCallExpression(receiver)) return false;
  const producer = receiver.getExpression();
  return Node.isPropertyAccessExpression(producer) && producer.getName() === "join";
}

export const CrossPlatformRule: Rule = {
  name: "cross-platform-compatibility",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());

    const lfSplitMatches = source
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => isLfSplit(call) && !isTrimmedSplit(call) && !isSelfProducedText(call));
    if (lfSplitMatches.length > 0) {
      findings.push({
        file: filePath,
        severity: "medium",
        title: "Cross-Platform: LF-only string splitting",
        why: `${lfSplitMatches.length} instance(s) of .split('\\n') detected. CRLF line endings (Windows) will not be handled.`,
        fix: "Replace .split('\\n') with .split(/\\r?\\n/) for cross-platform compatibility."
      });
    }
    return findings;
  }
};

export const SchemaContractRule: Rule = {
  name: "schema-contract-audit",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());
    const text = source.getText();

    if (!text.includes('.refine(') || !text.includes('z.object({')) {
      return findings;
    }

    // Walk the full method chain from a .refine() call to collect all method names
    // in both directions: wrapping calls like .optional() that surround .refine(),
    // and inner calls like .string() that precede .refine() in the chain.
    function collectMethodChain(callExpr: import("ts-morph").CallExpression): string[] {
      const methods: string[] = [];
      const MAX_DEPTH = 15;

      // Walk UP through ancestor PropertyAccessExpression → CallExpression chains
      // to capture wrapping calls like .optional() that surround .refine()
      let current: import("ts-morph").Node = callExpr;
      let depth = 0;
      while (current.getParent() && depth < MAX_DEPTH) {
        const parent = current.getParent();
        if (Node.isPropertyAccessExpression(parent)) {
          methods.push(parent.getName());
          const grandParent = parent.getParent();
          if (Node.isCallExpression(grandParent)) {
            current = grandParent;
            depth++;
            continue;
          }
        }
        break;
      }

      // Walk DOWN the expression chain to capture inner calls before .refine()
      // e.g. .string(), .min(1), .email() in z.string().min(1).refine(...).optional()
      let expr = callExpr.getExpression();
      depth = 0;
      while (Node.isPropertyAccessExpression(expr) && depth < MAX_DEPTH) {
        methods.push(expr.getName());
        const obj = expr.getExpression();
        if (Node.isCallExpression(obj)) {
          expr = obj.getExpression();
          depth++;
        } else {
          break;
        }
      }

      return methods;
    }

    source.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'refine') {
          // Only flag field-level refinements inside z.object({}) properties,
          // not schema-level .refine() on the entire z.object({}) return value
          const inObjectProperty = node.getFirstAncestorByKind(
            SyntaxKind.PropertyAssignment as unknown as import("ts-morph").SyntaxKind
          );
          if (!inObjectProperty) return;

          const chainMethods = collectMethodChain(node);
          // .default() provides the same protection as .optional() — if a field
          // has a default, missing input is handled without rejecting the request.
          const hasGuarantee = chainMethods.includes('optional') || chainMethods.includes('default');
          if (!hasGuarantee) {
            findings.push({
              file: filePath,
              severity: "critical",
              title: "Schema: Refinement on required field may reject valid requests",
              why: "z.refine() used without .optional() or .default() on the chained field. If a caller doesn't send this field, the entire request is rejected with 400.",
              fix: "Add .optional() or .default() before .refine() if the field isn't guaranteed from all call paths: .refine(...).optional()"
            });
          }
        }
      }
    });

    return findings;
  }
};

export const RedundantValidationRule: Rule = {
  name: "redundant-validation-detector",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());
    const text = source.getText();

    if (text.includes('.min(') && text.includes('.max(') && text.includes('z.object({')) {
      const hasManualRange = text.match(/if\s*\([^)]*(?:<|>)\s*\d+[^)]*\)/g);
      const zodMin = text.match(/\.min\(\d+\)/g);
      if (hasManualRange && zodMin) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: "Validation: Manual range check duplicates Zod schema",
          why: "Zod already enforces .min()/.max() bounds. Manual if-check after schema parse is redundant and can drift.",
          fix: "Remove manual range validation after schema.safeParse() — Zod handles it. Keep only post-parse semantic checks."
        });
      }
    }
    return findings;
  }
};

export const WorkflowRule: Rule = {
  name: "workflow-safety-check",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());

    // `exec` is a process call only when it comes from child_process; RegExp.prototype.exec is not.
    const execNames = new Set<string>();
    const childProcessNamespaces = new Set<string>();
    for (const decl of source.getImportDeclarations()) {
      if (!/^(node:)?child_process$/.test(decl.getModuleSpecifierValue())) continue;
      for (const named of decl.getNamedImports()) {
        if (named.getName() === "exec") execNames.add(named.getAliasNode()?.getText() ?? "exec");
      }
      const namespace = decl.getNamespaceImport() ?? decl.getDefaultImport();
      if (namespace) childProcessNamespaces.add(namespace.getText());
    }
    // require("child_process") binds the same module: a namespace (`const cp = require(...)`) or a destructured exec.
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== "require") continue;
      const [spec] = call.getArguments();
      if (!spec || !Node.isStringLiteral(spec) || !/^(node:)?child_process$/.test(spec.getLiteralValue())) continue;
      const binding = call.getParent();
      if (!Node.isVariableDeclaration(binding)) continue;
      const name = binding.getNameNode();
      if (Node.isIdentifier(name)) {
        childProcessNamespaces.add(name.getText());
      } else if (Node.isObjectBindingPattern(name)) {
        for (const element of name.getElements()) {
          if ((element.getPropertyNameNode()?.getText() ?? element.getName()) === "exec") execNames.add(element.getName());
        }
      }
    }
    const isChildProcessExec = (text: string): boolean =>
      execNames.has(text) || [...childProcessNamespaces].some((ns) => text === `${ns}.exec`);

    source.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        const text = expr.getText();

        const isNamed = (names: string[]): boolean => names.some(name => text === name || text.endsWith(`.${name}`));
        // An aliased or destructured exec (`exec as run`) is matched by its binding name too.
        const isIOCall = isNamed(["fetch", "writeFile", "exec", "execSync"]) || isChildProcessExec(text);
        // fetch holds no resource a finally block would release, so only the other calls need one.
        const needsFinally = isChildProcessExec(text) || isNamed(["writeFile", "execSync"]);

        if (isIOCall) {
          const tryStatement = node.getFirstAncestorByKind(SyntaxKind.TryStatement);
          const hasFinally = tryStatement?.getFinallyBlock();

          if (needsFinally && !hasFinally) {
            findings.push({
              file: filePath,
              severity: "medium",
              title: "Workflow: Missing finally block for I/O",
              why: `Risky I/O call '${text}' detected without an explicit finally block.`,
              fix: "Ensure all I/O operations are wrapped in a try/finally block to guarantee resource cleanup."
            });
          }

          const type = node.getType();
          if (type.getText().includes("Promise") || type.getSymbol()?.getName() === "Promise") {
             const parent = node.getParent();
             if (parent && !Node.isAwaitExpression(parent) && !Node.isReturnStatement(parent) && !Node.isYieldExpression(parent)) {
                if (Node.isExpressionStatement(parent)) {
                   findings.push({
                     file: filePath,
                     severity: "high",
                     title: "Workflow: Unawaited Promise",
                     why: `Loose unawaited promise detected for I/O call '${text}'.`,
                     fix: "Await the promise or explicitly handle it to avoid race conditions or floating promises."
                   });
                }
             }
          }
        }
      }
    });
    return findings;
  }
};

export const TranscriptUnsafeAccessRule: Rule = {
  name: "transcript-unsafe-access",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());
    if (!filePath.includes('Transcript') && !filePath.includes('transcript')) return findings;

    const text = source.getText();
    const deepChains = text.match(/results\[0\]\.\w+\.\w+\.\w+/g) || [];
    if (deepChains.length > 0) {
      findings.push({
        file: filePath,
        severity: "high",
        title: "Transcript: Unsafe deep property chain access",
        why: "results[0].content.auto_generated.en.events — any intermediate can be undefined. Causes TypeError on unexpected API shapes.",
        fix: "Use optional chaining: results?.[0]?.content?.auto_generated?.[lang]?.events ?? fallback"
      });
    }
    return findings;
  }
};

export const HardcodedDomainLogicRule: Rule = {
  name: "hardcoded-domain-logic",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());
    const text = source.getText();

    const hardcodedPersonas = text.match(/['"]?(?:detailed|balanced|brief|academic|casual)['"]?\s*[,:]\s*['"]?(?:detailed|balanced|brief|academic|casual)['"]?/g);
    if (hardcodedPersonas && filePath.includes('persona')) {
      findings.push({
        file: filePath,
        severity: "medium",
        title: "Domain: Hardcoded persona list may drift from actual personas",
        why: "isValidPersona() uses a hardcoded array. When new personas are added to UCI PersonaConfig, this must be manually updated.",
        fix: "Import persona list from UCI PersonaConfig or derive from a shared constant."
      });
    }
    return findings;
  }
};

export const StateSyncRule: Rule = {
  name: "state-sync-audit",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());
    const text = source.getText();

    if (text.includes('setUrl') && (filePath.includes('store') || filePath.includes('Store'))) {
      const hasSetIsValid = text.includes('setIsValid') || text.includes('isValid:');
      if (!hasSetIsValid) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: "State: setUrl doesn't sync isValid state",
          why: "setUrl() updates URL string but doesn't update isValid. Derived state drifts from source state.",
          fix: "Derive isValid from url inside the store, or call setIsValid in the same setter."
        });
      }
    }
    return findings;
  }
};

export const GraphAwareBoundaryRule: Rule = {
  name: "graph-aware-boundary",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(source.getFilePath());
    
    // Graph boundary checks: only run on domain/usecases files to ensure they don't depend on raw infrastructure
    if (!filePath.includes('/domain/') && !filePath.includes('/usecases/')) {
      return findings;
    }

    const imports = source.getImportDeclarations()
      .map((d) => d.getModuleSpecifierSourceFile()?.getFilePath() || d.getModuleSpecifierValue())
      .filter((p): p is string => Boolean(p))
      .map(normalizePosixPath);

    for (const imp of imports) {
      if (imp.includes("/adapters/") && (imp.includes("supabase") || imp.includes("db") || imp.includes("postgres"))) {
        findings.push({
          file: filePath,
          severity: "critical",
          title: "Boundary Violation: Domain relies on DB infrastructure in dependency graph",
          why: `Domain layer file ${filePath} has a direct dependency on adapter file ${imp}.`,
          fix: "Decouple domain from concrete adapters. Put adapter behind a port interface."
        });
      }
    }

    return findings;
  }
};

