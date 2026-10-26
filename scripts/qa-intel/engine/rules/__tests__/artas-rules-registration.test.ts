import { describe, test, expect } from "vitest";
import * as legacyRules from "../index";
import {
  UnconsumedStreamLeakRule,
  UnboundedBodyReadRule,
  NonIdempotentRetryRule,
  FailOpenUndefinedFilterRule,
} from "../artas-rules";

// Same rationale as the 2026-09-05/20260924 registration tests: direct
// .check() unit tests prove rule logic but not that the production
// registration path (rules/index.ts exports -> verify-quality-engine.ts's
// Object.values(legacyRules)) actually wires the rules into the real scan.

describe("ARTAS rules — production registration", () => {
  test("all four rules are present in the real Object.values(legacyRules) registration set", () => {
    const registered = Object.values(legacyRules);
    expect(registered).toContain(UnconsumedStreamLeakRule);
    expect(registered).toContain(UnboundedBodyReadRule);
    expect(registered).toContain(NonIdempotentRetryRule);
    expect(registered).toContain(FailOpenUndefinedFilterRule);
  });

  test("each rule carries the canonical ARTAS registry name", () => {
    expect(UnconsumedStreamLeakRule.name).toBe("artas-v20-unconsumed-stream");
    expect(UnboundedBodyReadRule.name).toBe("artas-v10-unbounded-body-read");
    expect(NonIdempotentRetryRule.name).toBe("artas-v19-non-idempotent-retry");
    expect(FailOpenUndefinedFilterRule.name).toBe("artas-v05-fail-open-filter");
  });

  test("verify-quality-engine.ts dispatch logic routes each rule as the new Rule format (scope defined), not a wrapped legacy IRule", () => {
    for (const rule of [UnconsumedStreamLeakRule, UnboundedBodyReadRule, NonIdempotentRetryRule, FailOpenUndefinedFilterRule]) {
      expect((rule as { scope?: string }).scope).toBe("file");
      expect(typeof rule.check).toBe("function");
    }
  });
});
