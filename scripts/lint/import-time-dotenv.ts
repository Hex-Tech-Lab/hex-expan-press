// Rule: no test may import a module that loads .env at import time.
//
// Why: scripts/sync-supabase-to-r2.ts called dotenv.config() at top level. Importing it from a test loaded the live
// .env, which holds production keys (see commit b543f30). CLI entry scripts may load .env at top level; the rule
// targets only modules that a test imports, and test files that load .env unconditionally.
//
// Detection (AST, ts-morph; no regex over source text except the callee name):
//   - a top-level ExpressionStatement calling `dotenv.config(...)` or `config(...)` in a file that imports "dotenv"
//   - a side-effect import of "dotenv/config"
// A conditional load (inside `if`, a function, or a direct-run guard) is allowed; that is the sanctioned fix shape.
import { Node, Project, type SourceFile } from "ts-morph";

export const TEST_FILE_RE = /(__tests__\/|\/test\/|\.test\.ts$)/;
const LOADER_CALLEE = /^(dotenv\.config|config)$/;

export function hasTopLevelDotenvLoader(sf: SourceFile): boolean {
  const decls = sf.getImportDeclarations();
  if (decls.some((d) => d.getModuleSpecifierValue() === "dotenv/config")) return true;
  if (!decls.some((d) => d.getModuleSpecifierValue() === "dotenv")) return false;
  return sf.getStatements().some((s) => {
    if (!Node.isExpressionStatement(s)) return false;
    const expr = s.getExpression();
    if (!Node.isCallExpression(expr)) return false;
    return LOADER_CALLEE.test(expr.getExpression().getText());
  });
}

function importedSourceFiles(sf: SourceFile): SourceFile[] {
  return sf
    .getImportDeclarations()
    .map((d) => d.getModuleSpecifierSourceFile())
    .filter((f): f is SourceFile => f !== undefined && !f.isInNodeModules() && !f.isDeclarationFile());
}

/** For each test file, every module it imports (transitively) and the test file itself must not load .env at import. */
export function importTimeDotenvLeaks(project: Project): string[] {
  const found = new Set<string>();
  for (const test of project.getSourceFiles().filter((f) => TEST_FILE_RE.test(f.getFilePath()))) {
    const seen = new Set<string>();
    const stack: SourceFile[] = [test];
    while (stack.length > 0) {
      const file = stack.pop() as SourceFile;
      if (seen.has(file.getFilePath())) continue;
      seen.add(file.getFilePath());
      if (hasTopLevelDotenvLoader(file)) found.add(`${file.getFilePath()} (loaded by test ${test.getFilePath()})`);
      stack.push(...importedSourceFiles(file));
    }
  }
  return [...found].sort();
}
