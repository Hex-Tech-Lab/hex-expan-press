import type { SourceFile } from "ts-morph";
import type { Finding } from "./domain/Finding";
import type { RuleLanguage } from "./domain/Rule";

// Shared rule and engine types. Finding has one declaration, in domain/Finding.ts; this module re-exports it.
export type { Finding } from "./domain/Finding";

export interface IRule {
  name: string;
  allowSelfAnalysis?: boolean;
  /** Languages the rule applies to; omitted means ts only, matching the engine gate. */
  languages?: readonly RuleLanguage[];
  check: (source: SourceFile) => Finding[];
}

export interface EngineConfig {
  cache?: {
    getAST(filePath: string): Promise<SourceFile | undefined>;
    setAST(filePath: string, src: SourceFile): Promise<void>;
  };
}
