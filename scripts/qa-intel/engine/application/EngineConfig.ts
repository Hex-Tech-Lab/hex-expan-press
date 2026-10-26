import type { RuleScope } from "../domain/Rule";

export type AnalysisMode = "diff" | "full";

export interface EngineConfig {
  mode: AnalysisMode;
  defaultScope?: RuleScope; // default "file"
  concurrency?: number; // default 3
}
