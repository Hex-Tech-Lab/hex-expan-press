// Rule: a module must not load .env (or any dotenv config) at import time.
//
// Why: a top-level dotenv.config() runs as soon as any file imports the module, so importing
// it from a test or another module reads the live .env (see commit 5ee9f4c, the
// sync-supabase-to-r2 leak). Only an entry point may load the environment.
//
// Detection mirrors scripts/lint/import-time-dotenv.ts (hasTopLevelDotenvLoader), but runs on
// the single file being scanned, so it needs no cross-file import graph:
//   - a side-effect import of "dotenv/config" (always top level in ESM)
//   - a top-level ExpressionStatement calling `dotenv.config(...)` or `config(...)` in a file
//     that imports "dotenv"
// A call nested in a function, an `if` (direct-run guard), or any other block is not a
// top-level statement, so it is never flagged: that is the sanctioned fix shape.
import { Node } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding, IRule } from "../engine";

const LOADER_CALLEE = /^(dotenv\.config|config)$/;
const FIX_HINT =
  "Move the dotenv.config() call (or the dotenv/config import) into the entry point's direct-run branch, " +
  "so importing this module never reads .env.";

export const ImportSideEffectsRule: IRule = {
  name: "import-side-effects-detector",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const decls = source.getImportDeclarations();

    for (const decl of decls) {
      if (decl.getModuleSpecifierValue() !== "dotenv/config") continue;
      findings.push({
        file: filePath,
        severity: "critical",
        title: "Import-time side effect: 'dotenv/config' imported at module top level",
        why: `Line ${decl.getStartLineNumber()} imports "dotenv/config", which loads .env as soon as this module is imported.`,
        fix: FIX_HINT,
      });
    }

    if (!decls.some((d) => d.getModuleSpecifierValue() === "dotenv")) return findings;

    for (const statement of source.getStatements()) {
      if (!Node.isExpressionStatement(statement)) continue;
      const expr = statement.getExpression();
      if (!Node.isCallExpression(expr)) continue;
      if (!LOADER_CALLEE.test(expr.getExpression().getText())) continue;
      findings.push({
        file: filePath,
        severity: "critical",
        title: "Import-time side effect: top-level dotenv.config() call",
        why: `Line ${statement.getStartLineNumber()} calls ${expr.getExpression().getText()}() at module top level, so importing this module loads .env.`,
        fix: FIX_HINT,
      });
    }

    return findings;
  },
};
