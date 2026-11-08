/**
 * Rules mined from the 2026-10-09 PR backlog (#448 / #449 / #451 lint and review).
 *
 * - StreamReaderWithoutFinallyRule: #448 Lint flagged I/O without a finally block.
 *   WorkflowRule already covers fetch/writeFile/exec; this adds the stream arm
 *   (`response.body.getReader()`), where an unreleased reader pins the stream.
 * - UnregisteredSettingsKeyRule: #451 (Cubic P2) found `analysis.pipeline.retry.epistemic`
 *   used in code but never registered in setting_definitions, so the registry lookup
 *   always returned the code fallback and the setting could never take effect.
 *
 * Both are text/AST heuristics with the same accepted limits as the rest of the engine.
 */
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import type { Finding } from "../domain/Finding";
import type { Rule, RuleContext } from "../domain/Rule";

function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes("__tests__/");
}

function findEnclosingFunctionBody(node: Node): Node | undefined {
  return node.getFirstAncestor((a) =>
    Node.isFunctionDeclaration(a) || Node.isFunctionExpression(a) || Node.isArrowFunction(a) || Node.isMethodDeclaration(a)
  );
}

/**
 * A reader taken from a stream must be released on every exit path. Passes when the
 * enclosing function has a try/finally whose finally block releases or cancels that
 * same reader (matched by its variable name when it has one).
 */
export const StreamReaderWithoutFinallyRule: Rule = {
  name: "lessons-20261009-stream-reader-no-finally",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    source.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const callee = node.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "getReader") return;

      // Tie the cleanup to THIS reader: `const r = x.getReader()` must be
      // released as `r.releaseLock()` / `r.cancel()`. An unnamed reader can
      // only be released through its stream, so `.cancel(` still counts there.
      const decl = node.getParentIfKind(SyntaxKind.VariableDeclaration);
      const name = decl?.getName();
      const id = name?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const releases = id
        ? new RegExp(`\\b${id}\\s*\\??\\.\\s*(?:releaseLock|cancel)\\s*\\(`)
        : /releaseLock\s*\(|\.cancel\s*\(/;
      const scope: Node = findEnclosingFunctionBody(node) ?? source;
      const released = scope.getDescendantsOfKind(SyntaxKind.TryStatement).some((t) => {
        const fin = t.getFinallyBlock();
        return !!fin && releases.test(fin.getText());
      });
      if (released) return;

      findings.push({
        file: filePath,
        severity: "medium",
        title: "Stream reader not released in a finally block",
        why: "getReader() takes the stream lock. Without a finally that calls releaseLock() or cancel(), an exception or early return leaves the stream locked and its underlying connection open.",
        fix: "Wrap the reads in try { ... } finally { reader.releaseLock(); } (or reader.cancel() on the error path).",
      });
    });

    return findings;
  },
};

let manifestCache: Set<string> | null = null;

/**
 * Keys registered in setting_definitions, read from supabase/migrations. Each registry
 * row is matched as `'<key>', '<tier>',` with tier system|admin|user; a row in another
 * shape or tier is not read, and its key may then be reported as unregistered when
 * its prefix is registered elsewhere.
 * The directory is found by walking up from the cwd, so the rule works when the
 * scanner or a test runs from a package dir such as web/. Returns an empty set when
 * no migrations directory exists, which disables the rule rather than flagging every key.
 */
function findMigrationsDir(start: string): string | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "supabase", "migrations");
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

function loadSettingsManifest(): Set<string> {
  if (manifestCache) return manifestCache;
  const keys = new Set<string>();
  const dir = findMigrationsDir(process.cwd());
  if (dir) {
    const pattern = /'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)',\s*'(?:system|admin|user)',/g;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".sql")) continue;
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      for (const m of text.matchAll(pattern)) keys.add(m[1]);
    }
  }
  manifestCache = keys;
  return keys;
}

/** Test seam: reset the memoised manifest so a test can point at a different tree. */
export function _resetSettingsManifestCacheForTest(): void {
  manifestCache = null;
}

const DOTTED_KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;
const REGISTRY_CALLEE = /(registry|setting|resolve)/i;

/**
 * A dotted key with a registry prefix (the first segment of any registered key) that is
 * not in the manifest is a lookup that can never hit a real row. Checked in two places:
 * `*_KEY` constants, and string literals passed to registry-style calls.
 */
export const UnregisteredSettingsKeyRule: Rule = {
  name: "lessons-20261009-unregistered-setting-key",
  scope: "file",
  check: (ctx: RuleContext) => {
    const source = ctx.ast as SourceFile;
    const findings: Finding[] = [];
    const filePath = normalizePosixPath(ctx.filePath);
    if (isTestFile(filePath)) return findings;

    const manifest = loadSettingsManifest();
    if (manifest.size === 0) return findings;
    const prefixes = new Set([...manifest].map((k) => k.split(".")[0]));

    const flag = (key: string) => {
      if (manifest.has(key)) return;
      if (!prefixes.has(key.split(".")[0])) return;
      findings.push({
        file: filePath,
        severity: "high",
        title: "Settings key not registered in setting_definitions",
        why: `Key '${key}' is looked up in code but has no setting_definitions row, so the registry always returns the code fallback and the value can never be overridden.`,
        fix: "Add an insert into setting_definitions (key, tier, data_type, validation, default_value, description, owner_role) in a migration, or correct the key to a registered one.",
      });
    };

    source.forEachDescendant((node) => {
      if (Node.isVariableDeclaration(node)) {
        const name = node.getName();
        const raw = node.getInitializer();
        // `'key' as const` wraps the literal in an AsExpression; unwrap it.
        const init = raw && Node.isAsExpression(raw) ? raw.getExpression() : raw;
        if (/_KEYS?$/.test(name) && init && Node.isStringLiteral(init) && DOTTED_KEY.test(init.getLiteralValue())) {
          flag(init.getLiteralValue());
        }
        return;
      }
      if (Node.isCallExpression(node)) {
        const callee = node.getExpression().getText();
        if (!REGISTRY_CALLEE.test(callee)) return;
        for (const arg of node.getArguments()) {
          const literals = Node.isArrayLiteralExpression(arg) ? arg.getElements() : [arg];
          for (const el of literals) {
            if (Node.isStringLiteral(el) && DOTTED_KEY.test(el.getLiteralValue())) {
              flag(el.getLiteralValue());
            }
          }
        }
      }
    });

    return findings;
  },
};
