import type { Finding } from "./Finding";
import type { SourceGraph } from "./SourceGraph";

export type RuleScope = "file" | "neighbors" | "graph";

/**
 * Source-file language families a rule applies to. Defaults to ts when
 * omitted — Wave Q4 (2026-09-24) added supabase/migrations/*.sql to the scan
 * surface, and without this gate the text/TS heuristics false-fire on SQL
 * files (58 false positives on the first full run).
 */
export type RuleLanguage = "ts" | "sql";

export interface RuleContext {
  filePath: string;
  ast: any; // ts-morph SourceFile, adapted by infra
  graph?: SourceGraph;
  // Every file in the current scan (diff or full), regardless of rule scope.
  // Lets a file-scoped rule ask "is there a sibling test file in this same
  // scan?" without needing graph/neighbors traversal — e.g.
  // SecurityFixWithoutTestRule checks this to flag an authorization change
  // with no corresponding test file touched in the same diff.
  allFiles?: string[];
  // The engine's scan mode (EngineConfig.mode): "diff"-like scans only
  // include changed files, "full" scans every tracked file. Lets a rule
  // distinguish "in the scan" (= edited, in diff mode) from "merely present
  // in a whole-repo audit" — e.g. sql-migrations severityFor downgrades
  // historical pre-wave migrations to informational low ONLY in full mode.
  scanMode?: "diff" | "full";
}

export interface Rule {
  name: string;
  scope?: RuleScope; // default = "file"
  // Most rules are excluded from scripts/quality-engine/rules/** and
  // scripts/verify-quality-engine.ts to suppress self-analysis false
  // positives (see QualityEngine.analyze). A rule that specifically audits
  // the quality-engine's own rule files (e.g. UnregisteredRuleExportRule)
  // must opt in here, or it silently never runs against its own target.
  allowSelfAnalysis?: boolean;
  languages?: readonly RuleLanguage[];
  check(ctx: RuleContext): Finding[];
}
