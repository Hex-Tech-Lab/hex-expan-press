import type { Rule, RuleContext } from "../domain/Rule";
import type { Finding } from "../domain/Finding";
import type { SourceFile } from "ts-morph";

export interface LegacyIRule {
  name: string;
  scope?: "file" | "neighbors" | "graph";
  allowSelfAnalysis?: boolean;
  check: (source: SourceFile, ctx?: unknown) => Finding[];
}

export function wrapLegacyRule(legacyRule: LegacyIRule): Rule {
  return {
    name: legacyRule.name,
    scope: legacyRule.scope ?? "file",
    allowSelfAnalysis: legacyRule.allowSelfAnalysis,
    check(ctx: RuleContext): Finding[] {
      return legacyRule.check((ctx.ast as SourceFile), ctx);
    }
  };
}
