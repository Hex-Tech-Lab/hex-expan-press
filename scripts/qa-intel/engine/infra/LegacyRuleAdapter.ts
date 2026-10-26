import type { Rule, RuleContext } from "../domain/Rule";
import type { Finding } from "../domain/Finding";

export interface LegacyIRule {
  name: string;
  scope?: "file" | "neighbors" | "graph";
  allowSelfAnalysis?: boolean;
  check: (source: any, ctx?: any) => Finding[];
}

export function wrapLegacyRule(legacyRule: LegacyIRule): Rule {
  return {
    name: legacyRule.name,
    scope: legacyRule.scope ?? "file",
    allowSelfAnalysis: legacyRule.allowSelfAnalysis,
    check(ctx: RuleContext): Finding[] {
      return legacyRule.check(ctx.ast, ctx);
    }
  };
}
