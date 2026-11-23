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
      if (/\bunknown\b/.test(typeText) || /Record\s*<\s*string\s*,\s*unknown\s*>\s*\|\s*undefined/.test(typeText)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Flags `'key' in raw` when `raw` is typed as `unknown` or optional
 * `Record<string, unknown> | undefined` without an explicit `typeof raw === "object"`
 * (or helper) narrowing check in the enclosing scope. `if (!raw)` alone passes
 * truthy primitives such as strings or numbers, causing `in` to throw TypeError.
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
      const scopeText = (fn ?? source).getText();
      const escaped = escapeRegExp(targetText);
      const hasObjectGuard =
        new RegExp(`typeof\\s+${escaped}\\s*(?:===|!==)\\s*['"\`]object['"\`]`).test(scopeText) ||
        new RegExp(`\\b(?:isPlainObject|isRecord|isObject)\\s*\\(\\s*${escaped}\\s*\\)`).test(scopeText);
      if (hasObjectGuard) return;

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

function extractSqlCreateFunctionBlocks(sql: string): Array<{ name: string; fullBlock: string }> {
  const out: Array<{ name: string; fullBlock: string }> = [];
  const createRe = /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-zA-Z0-9_."]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(sql)) !== null) {
    const start = match.index;
    const name = match[1];
    const rest = sql.slice(start);
    const semiIdx = rest.search(/;\s*(?:\n|$)/);
    // Find the $$ or $tag$ delimiter closing if present so inner `;` statements don't truncate the block.
    const tagMatch = /\$[A-Za-z0-9_]*\$/.exec(rest);
    if (tagMatch) {
      const tag = tagMatch[0];
      const openIdx = tagMatch.index + tag.length;
      const closeIdx = rest.indexOf(tag, openIdx);
      if (closeIdx !== -1) {
        const afterClose = rest.indexOf(";", closeIdx + tag.length);
        const end = afterClose !== -1 ? start + afterClose + 1 : start + closeIdx + tag.length;
        out.push({ name, fullBlock: sql.slice(start, end) });
        createRe.lastIndex = end;
        continue;
      }
    }
    const fallbackEnd = semiIdx !== -1 ? start + semiIdx + 1 : sql.length;
    out.push({ name, fullBlock: sql.slice(start, fallbackEnd) });
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
      // Preserve explicit `auth.role() = 'service_role' or current_user = 'service_role'` dual service checks
      const stripped = stripSqlStringsPreservingStructure(block.fullBlock)
        .replace(/auth\.role\(\)[\s\S]{0,60}?\bor\s+current_user\s*=\s*''/gi, "");
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

    let dotenvDefaultName: string | undefined;
    let dotenvConfigNamed: string | undefined;

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
        dotenvDefaultName = imp.getDefaultImport()?.getText();
        for (const named of imp.getNamedImports()) {
          if (named.getName() === "config") {
            dotenvConfigNamed = (named.getAliasNode() ?? named.getNameNode()).getText();
          }
        }
      }
    }

    if (!dotenvDefaultName && !dotenvConfigNamed) return findings;

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const expr = node.getExpression();
      const isDotenvCall =
        (dotenvDefaultName &&
          Node.isPropertyAccessExpression(expr) &&
          expr.getExpression().getText() === dotenvDefaultName &&
          expr.getName() === "config") ||
        (dotenvConfigNamed && Node.isIdentifier(expr) && expr.getText() === dotenvConfigNamed);
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

function isSafeReplacementArg(node: Node): boolean {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return true;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return !node.getLiteralText().includes("$");
  }
  const text = node.getText();
  if (/^encodeURIComponent\s*\(/.test(text)) return true;
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
      if (isSafeReplacementArg(args[1])) return;

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
