/**
 * Rules mined from PRs #136-#162 in docs/review/CUBIC_VECTOR_LEDGER.md (2026-11-23).
 *
 * - UnguardedInOperatorRule: PR #138 (settings_registry.ts:654) & PR #159
 *   (settings_registry.ts:2578) — Cubic P2 caught `'key' in raw` crashing with
 *   TypeError when a malformed scalar (`"str"`, `123`, `true`) passed `if (!raw)`.
 * - SqlSecurityDefinerCurrentUserRule: PR #138 (house_title_exemption.sql:41)
 *   — Cubic P2 flagged `current_user` inside elevated Postgres contexts where
 *   `current_user` resolves to the function owner (`postgres`), not the caller.
 * - DotenvWithoutOverrideRule: PR #136 (scripts/ops/usage_watch.ts:330) —
 *   Cubic P2 caught `dotenv.config()` without `{ override: true }`, letting stale
 *   shell env vars silently shadow `.env`.
 * - ReplaceWithDynamicDollarReplacementRule: PR #142 (book-preview-toolbar.tsx:138,
 *   book-previewer.tsx:418) — Cubic P3 × 2 caught `.replace("{title}", title)` where
 *   `$&`/`$$`/`$1` sequences in `title` corrupt the replaced output.
 */
import { Node, SyntaxKind } from "ts-morph";
import { stripComments } from "./security-lessons-20261010";
import type { SourceFile } from "ts-morph";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("__tests__/");
}

function findEnclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isFunctionExpression(a) ||
      Node.isArrowFunction(a) ||
      Node.isMethodDeclaration(a),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RUNTIME_GLOBAL_TARGETS = new Set(["window", "document", "globalThis", "self", "navigator", "process"]);

function isUncertainRecordTarget(node: Node): boolean {
  const fn = findEnclosingFunction(node);
  if (!fn) return false;
  const targetName = node.getText().trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(targetName)) return false;

  if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isArrowFunction(fn) || Node.isMethodDeclaration(fn)) {
    for (const param of fn.getParameters()) {
      if (param.getName() !== targetName) continue;
      const typeText = param.getTypeNode()?.getText() ?? "";
      const unionMembers = typeText.split("|").map((part) => part.trim());
      const hasUnknownTopLevel = unionMembers.includes("unknown");
      const hasOptionalRecord =
        unionMembers.some((part) => /^Record\s*<\s*string\s*,/.test(part)) &&
        unionMembers.some((part) => part === "undefined" || part === "null");
      if (hasUnknownTopLevel || hasOptionalRecord) {
        return true;
      }
    }
  }
  return false;
}

function collectGuardTextsBefore(node: Node, boundary: Node): string[] {
  const texts: string[] = [];
  let current: Node | undefined = node;
  while (current && current !== boundary) {
    const parent = current.getParent();
    if (!parent) break;
    if (Node.isBinaryExpression(parent) && parent.getRight() === current) {
      const op = parent.getOperatorToken().getText();
      if (op === "&&" || op === "||") {
        texts.push(parent.getLeft().getText());
      }
    } else if (Node.isIfStatement(parent)) {
      if (parent.getThenStatement() === current) {
        texts.push(parent.getExpression().getText());
      }
    } else if (Node.isConditionalExpression(parent) && parent.getWhenTrue() === current) {
      texts.push(parent.getCondition().getText());
    } else if (Node.isBlock(parent) || Node.isSourceFile(parent)) {
      const stmts = parent.getStatements();
      const idx = stmts.indexOf(current as never);
      for (let i = 0; i < idx; i++) {
        const stmt = stmts[i];
        // Ignore nested function declarations/expressions whose internal checks do not guard the outer scope.
        if (!Node.isFunctionDeclaration(stmt)) {
          texts.push(stmt.getText());
        }
      }
    }
    current = parent;
  }
  return texts;
}

function hasObjectAndNonNullGuard(node: Node, fn: Node, targetName: string): boolean {
  const escaped = escapeRegExp(targetName);
  const objectHelperRe = new RegExp(`\\b(?:isPlainObject|isRecord|isObject)\\s*\\(\\s*${escaped}\\s*\\)`);
  const typeofRe = new RegExp(`typeof\\s+${escaped}\\s*(?:===|!==)\\s*['"\`]object['"\`]`);
  const nonNullRe = new RegExp(
    `(?:!\\s*${escaped}\\b|\\b${escaped}\\s*(?:!==|!=|===|==)\\s*null\\b|\\bnull\\s*(?:!==|!=|===|==)\\s*${escaped}\\b|Boolean\\s*\\(\\s*${escaped}\\s*\\)|\\b${escaped}\\s*&&)`,
  );

  let hasObjectCheck = false;
  let hasNullCheck = false;
  for (const snippet of collectGuardTextsBefore(node, fn)) {
    // Strip nested closures/arrows before checking outer guards.
    const clean = snippet.replace(/\([^)]*\)\s*=>\s*\{[\s\S]*?\}/g, " ");
    if (objectHelperRe.test(clean)) return true;
    if (typeofRe.test(clean)) hasObjectCheck = true;
    if (nonNullRe.test(clean)) hasNullCheck = true;
    if (hasObjectCheck && hasNullCheck) return true;
  }
  return false;
}

/**
 * Flags `'key' in raw` when `raw` is typed as top-level `unknown` or optional
 * `Record<string, ...> | undefined` without both `typeof raw === "object"` and
 * non-null narrowing on a dominating branch before the `in` expression.
 */
export const UnguardedInOperatorRule: Rule = {
  name: "lessons-20261123-unguarded-in-operator",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    const reported = new Set<string>();
    source.forEachDescendant((node) => {
      if (!Node.isBinaryExpression(node)) return;
      if (node.getOperatorToken().getKind() !== SyntaxKind.InKeyword) return;

      const right = node.getRight();
      const targetText = right.getText().trim();
      if (RUNTIME_GLOBAL_TARGETS.has(targetText)) return;
      if (!isUncertainRecordTarget(right)) return;

      const fn = findEnclosingFunction(node);
      if (fn && hasObjectAndNonNullGuard(node, fn, targetText)) return;

      const dedupeKey = `${filePath}:${targetText}`;
      if (reported.has(dedupeKey)) return;
      reported.add(dedupeKey);

      findings.push({
        file: filePath,
        severity: "high",
        title: `Reliability: Unguarded 'in' operator on '${targetText}'`,
        why: `'key in ${targetText}' throws TypeError when '${targetText}' is a truthy scalar (string/number/boolean). 'if (!${targetText})' does not guard primitives (PR #138 settings_registry.ts:654 & PR #159 settings_registry.ts:2578).`,
        fix: `Narrow before using 'in': if (!${targetText} || typeof ${targetText} !== "object" || Array.isArray(${targetText})) return defaults;`,
      });
    });

    return findings;
  },
};

const RULE_WAVE_DATE = "20261123";

function migrationDate(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^\d{8}/.test(base) ? base.slice(0, 8) : "";
}

function sqlSeverity(
  filePath: string,
  baseSeverity: Finding["severity"],
  allFiles?: readonly string[],
  scanMode?: "diff" | "full",
): Finding["severity"] {
  const date = migrationDate(filePath);
  if (!date || date >= RULE_WAVE_DATE) return baseSeverity;
  if (scanMode === "full") return "low";
  if (scanMode === "diff") return baseSeverity;
  const norm = filePath.replace(/\\/g, "/");
  if (allFiles?.some((f) => f.replace(/\\/g, "/") === norm)) return baseSeverity;
  return "low";
}

function stripSqlStringsPreservingStructure(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

function extractSqlCreateFunctionBlocks(sql: string): Array<{ name: string; fullBlock: string; bodyText: string }> {
  const out: Array<{ name: string; fullBlock: string; bodyText: string }> = [];
  const createRe = /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-zA-Z0-9_."]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(sql)) !== null) {
    const start = match.index;
    const name = match[1];
    const rest = sql.slice(start);
    const semiIdx = rest.search(/;\s*(?:\n|$)/);
    // Match either a $tag$...$tag$ dollar-quoted body or a single-quoted AS '...' body.
    const tagMatch = /\$[A-Za-z0-9_]*\$/.exec(rest);
    const singleQuoteMatch = /\bas\s+'((?:''|[^'])*)'/i.exec(rest);
    if (tagMatch && (!singleQuoteMatch || tagMatch.index < singleQuoteMatch.index)) {
      const tag = tagMatch[0];
      const openIdx = tagMatch.index + tag.length;
      const closeIdx = rest.indexOf(tag, openIdx);
      if (closeIdx !== -1) {
        const afterClose = rest.indexOf(";", closeIdx + tag.length);
        const end = afterClose !== -1 ? start + afterClose + 1 : start + closeIdx + tag.length;
        out.push({ name, fullBlock: sql.slice(start, end), bodyText: rest.slice(openIdx, closeIdx) });
        createRe.lastIndex = end;
        continue;
      }
    } else if (singleQuoteMatch) {
      const afterQuote = rest.indexOf(";", singleQuoteMatch.index + singleQuoteMatch[0].length);
      const end = afterQuote !== -1 ? start + afterQuote + 1 : start + singleQuoteMatch.index + singleQuoteMatch[0].length;
      const decodedBody = singleQuoteMatch[1].replace(/''/g, "'");
      out.push({ name, fullBlock: sql.slice(start, end), bodyText: decodedBody });
      createRe.lastIndex = end;
      continue;
    }
    const fallbackEnd = semiIdx !== -1 ? start + semiIdx + 1 : sql.length;
    const fullBlock = sql.slice(start, fallbackEnd);
    out.push({ name, fullBlock, bodyText: fullBlock });
  }
  return out;
}

/**
 * Inside a PostgreSQL `SECURITY DEFINER` function, `current_user` resolves to
 * the function owner (typically `postgres`), not the invoking client role.
 * Checks like `current_user not in ('postgres', ...)` inside definer-reachable
 * functions silently succeed regardless of caller.
 */
export const SqlSecurityDefinerCurrentUserRule: Rule = {
  name: "lessons-20261123-sql-definer-current-user",
  scope: "file",
  languages: ["sql"],
  check: (ctx: RuleContext) => {
    const filePath = normalizePosixPath(ctx.filePath);
    if (!filePath.endsWith(".sql") || filePath.includes("/__tests__/")) return [];
    const sourceText = (ctx.ast as { getFullText?: () => string } | undefined)?.getFullText?.() ?? String(ctx.ast ?? "");
    const noComments = stripComments(sourceText, "sql");
    const findings: Finding[] = [];

    for (const block of extractSqlCreateFunctionBlocks(noComments)) {
      if (!/\bsecurity\s+definer\b/i.test(block.fullBlock)) continue;
      // Preserve only explicit dual service_role checks BEFORE stripping SQL strings.
      const withoutDualServiceCheck = stripComments(block.bodyText, "sql").replace(
        /\(\s*(?:coalesce\s*\(\s*\(?\s*select\s+auth\.role\(\)\s*\)?\s*=\s*'service_role'\s*,\s*false\s*\)|auth\.role\(\)\s*=\s*'service_role')\s+or\s+current_user\s*=\s*'service_role'\s*\)/gi,
        "",
      );
      const stripped = stripSqlStringsPreservingStructure(withoutDualServiceCheck);
      if (!/\bcurrent_user\b/i.test(stripped)) continue;

      findings.push({
        file: filePath,
        severity: sqlSeverity(filePath, "high", ctx.allFiles, ctx.scanMode),
        title: "SQL: SECURITY DEFINER function relies on current_user instead of caller identity",
        why: `Function '${block.name}' runs with SECURITY DEFINER and checks 'current_user', which resolves to the function owner inside definer execution rather than the caller (PR #138 house_title_exemption.sql:41).`,
        fix: "Use session_user, auth.uid(), or auth.role() / current_setting('request.jwt.claims', true) for caller identity checks instead of current_user.",
      });
    }

    return findings;
  },
};

/**
 * `dotenv.config()` does not overwrite variables already present in `process.env`.
 * Stale shell exports (documented in AGENTS.md and PR #136 usage_watch.ts:330)
 * silently win over `.env`, causing 401s or wrong-project mutations.
 */
export const DotenvWithoutOverrideRule: Rule = {
  name: "lessons-20261123-dotenv-without-override",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    const dotenvNamespaces = new Set<string>();
    const dotenvConfigNamed = new Set<string>();

    for (const imp of source.getImportDeclarations()) {
      const mod = imp.getModuleSpecifierValue();
      if (mod === "dotenv/config") {
        findings.push({
          file: filePath,
          severity: "medium",
          title: "Reliability: Side-effect 'dotenv/config' import omits { override: true }",
          why: "Side-effect 'dotenv/config' never overrides existing shell env vars, so stale ~/.bashrc exports silently shadow .env (AGENTS.md & PR #136 usage_watch.ts:330).",
          fix: "Import dotenv explicitly and call dotenv.config({ override: true }).",
        });
      }
      if (mod === "dotenv") {
        const def = imp.getDefaultImport()?.getText();
        if (def) dotenvNamespaces.add(def);
        const ns = imp.getNamespaceImport()?.getText();
        if (ns) dotenvNamespaces.add(ns);
        for (const named of imp.getNamedImports()) {
          if (named.getName() === "config") {
            dotenvConfigNamed.add((named.getAliasNode() ?? named.getNameNode()).getText());
          }
        }
      }
    }

    if (dotenvNamespaces.size === 0 && dotenvConfigNamed.size === 0) return findings;

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      const isDotenvCall =
        (Node.isPropertyAccessExpression(expr) &&
          dotenvNamespaces.has(expr.getExpression().getText()) &&
          expr.getName() === "config") ||
        (Node.isIdentifier(expr) && dotenvConfigNamed.has(expr.getText()));
      if (!isDotenvCall) return;

      const args = node.getArguments();
      const opts = args[0];
      const hasOverrideTrue =
        opts !== undefined &&
        Node.isObjectLiteralExpression(opts) &&
        (() => {
          const prop = opts.getProperty("override");
          return prop !== undefined && Node.isPropertyAssignment(prop) && prop.getInitializer()?.getText() === "true";
        })();

      if (!hasOverrideTrue) {
        findings.push({
          file: filePath,
          severity: "medium",
          title: "Reliability: dotenv config() call omits override: true",
          why: "dotenv.config() leaves stale shell environment variables in control when they already exist in process.env (PR #136 usage_watch.ts:330).",
          fix: "Pass { override: true } to dotenv.config(...).",
        });
      }
    });

    return findings;
  },
};

function isLiteralPlaceholder(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    const val = node.getLiteralText();
    return /\{[a-zA-Z0-9_]+\}|%s/.test(val);
  }
  return false;
}

function isCallableIdentifier(node: Node, source: SourceFile): boolean {
  if (!Node.isIdentifier(node)) return false;
  const name = node.getText();
  if (source.getFunction(name)) return true;
  for (const decl of source.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== name) continue;
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return true;
    }
  }
  return false;
}

function isSafeReplacementArg(node: Node, source: SourceFile): boolean {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return true;
  if (isCallableIdentifier(node, source)) return true;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return !node.getLiteralText().includes("$");
  }
  if (Node.isCallExpression(node) && node.getExpression().getText() === "encodeURIComponent") {
    return true;
  }
  return false;
}

/**
 * Passing a dynamic string to `String.prototype.replace(placeholder, val)` or
 * `.replaceAll(...)` interprets `$&`, `$$`, ``$` ``, `$'`, and `$n` sequences in `val`.
 * A book title like `"Cost $$ & Value"` silently corrupts ARIA/UI strings.
 */
export const ReplaceWithDynamicDollarReplacementRule: Rule = {
  name: "lessons-20261123-replace-dynamic-dollar",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) return;
      const method = expr.getName();
      if (method !== "replace" && method !== "replaceAll") return;

      const args = node.getArguments();
      if (args.length < 2) return;
      if (!isLiteralPlaceholder(args[0])) return;
      if (isSafeReplacementArg(args[1], source)) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: `Code Quality: Dynamic placeholder .${method}() without function replacer`,
        why: `String.prototype.${method}(${args[0].getText()}, ${args[1].getText()}) expands $ sequences ($&, $$, $1) in the replacement value at runtime (PR #142 book-preview-toolbar.tsx:138 & book-previewer.tsx:418).`,
        fix: `Wrap the replacement in a function so $ sequences are treated literally: .${method}(${args[0].getText()}, () => ${args[1].getText()})`,
      });
    });

    return findings;
  },
};
