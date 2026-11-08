import type { Rule, RuleContext, RuleLanguage, RuleScope } from "../domain/Rule";
import type { Finding } from "../domain/Finding";
import type { SourceFile } from "ts-morph";

export interface LegacyIRule {
  name: string;
  scope?: RuleScope;
  allowSelfAnalysis?: boolean;
  languages?: readonly RuleLanguage[];
  check: (source: SourceFile, ctx?: unknown) => Finding[];
}

export function wrapLegacyRule(legacyRule: LegacyIRule): Rule {
  return {
    name: legacyRule.name,
    scope: legacyRule.scope ?? "file",
    allowSelfAnalysis: legacyRule.allowSelfAnalysis,
    // Forwarded so the engine gate sees the rule's real languages; dropping it made SQL-aware rules skip migrations.
    languages: legacyRule.languages,
    check(ctx: RuleContext): Finding[] {
      return legacyRule.check((ctx.ast as SourceFile), ctx);
    }
  };
}
