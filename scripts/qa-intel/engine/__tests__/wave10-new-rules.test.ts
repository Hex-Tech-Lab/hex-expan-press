/**
 * WAVE 10: New QA-Intel Rules Verification Tests (2026-09-11)
 *
 * These rules were mined from a retrospective sweep of 62 external review
 * findings (Cubic/CodeRabbit/Sourcery) across 58 merged PRs — see
 * docs/qa-intel/RETRO_WAVE_FINDINGS_2026-09-11.md for the full inventory.
 */

import { test, describe, expect } from 'vitest';
import { Project } from 'ts-morph';
import {
  ErrorNormalizationRule,
  NumberCoercionGuardRule,
  UnregisteredRuleExportRule,
} from '../rules/quality';
import type { SourceFile } from 'ts-morph';

function createTestSource(code: string, path = 'test.ts'): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(path, code);
}

describe('WAVE 10: ErrorNormalizationRule', () => {
  test('flags a catch var forwarded to Sentry without normalization', () => {
    const code = `
      try {
        doThing();
      } catch (err) {
        Sentry.captureException(err);
      }
    `;
    const findings = ErrorNormalizationRule.check(createTestSource(code));
    expect(findings.some(finding => finding.title.includes("'err'"))).toBe(true);
  });

  test('does not flag a catch var normalized before forwarding', () => {
    const code = `
      try {
        doThing();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Sentry.captureException(err);
        console.error('[context]', message);
      }
    `;
    const findings = ErrorNormalizationRule.check(createTestSource(code));
    expect(findings.some(finding => finding.title.includes("'err'"))).toBe(false);
  });

  test('does not flag a catch block that never forwards the caught value', () => {
    const code = `
      try {
        doThing();
      } catch (err) {
        retryCount++;
      }
    `;
    const findings = ErrorNormalizationRule.check(createTestSource(code));
    expect(findings.length).toBe(0);
  });

  test('flags an unnormalized rethrow', () => {
    const code = `
      try {
        doThing();
      } catch (err) {
        throw err;
      }
    `;
    const findings = ErrorNormalizationRule.check(createTestSource(code));
    expect(findings.some(finding => finding.title.includes("'err'"))).toBe(true);
  });
});

describe('WAVE 10: NumberCoercionGuardRule', () => {
  test('flags an unguarded Number() coercion on external data', () => {
    const code = `
      const offset = Number(searchParams.get('offset'));
    `;
    const findings = NumberCoercionGuardRule.check(createTestSource(code));
    expect(findings.length).toBe(1);
  });

  test('does not flag Number() on a typeof-guarded value', () => {
    const code = `
      const offset = typeof rawOffset === 'number' || typeof rawOffset === 'string' ? Number(rawOffset) : 2.5;
    `;
    const findings = NumberCoercionGuardRule.check(createTestSource(code));
    expect(findings.length).toBe(0);
  });

  test('does not flag Number() on a nullish-guarded value', () => {
    const code = `
      const offset = rawOffset != null ? Number(rawOffset) : 2.5;
    `;
    const findings = NumberCoercionGuardRule.check(createTestSource(code));
    expect(findings.length).toBe(0);
  });

  test('does not flag Number() on a string literal', () => {
    const code = `
      const count = Number("10");
    `;
    const findings = NumberCoercionGuardRule.check(createTestSource(code));
    expect(findings.length).toBe(0);
  });
});

describe('WAVE 10: UnregisteredRuleExportRule', () => {
  test('flags a rule exported but never passed to addRule() in the registrar', () => {
    const code = `
      import type { IRule } from "../engine";
      export const SomeNewRule: IRule = { name: "x", check: () => [] };
      export const OtherRule: IRule = { name: "y", check: () => [] };
      export function registerSecurityRules(engine: unknown) {
        const e = engine as any;
        e.addRule(OtherRule);
      }
    `;
    const findings = UnregisteredRuleExportRule.check(
      createTestSource(code, 'scripts/quality-engine/rules/security.ts')
    );
    expect(findings.some(finding => finding.title.includes("'SomeNewRule'"))).toBe(true);
    expect(findings.some(finding => finding.title.includes("'OtherRule'"))).toBe(false);
  });

  test('does not flag anything when every rule is registered', () => {
    const code = `
      import type { IRule } from "../engine";
      export const RuleA: IRule = { name: "a", check: () => [] };
      export function registerQualityRules(engine: unknown) {
        const e = engine as any;
        e.addRule(RuleA);
      }
    `;
    const findings = UnregisteredRuleExportRule.check(
      createTestSource(code, 'scripts/quality-engine/rules/quality.ts')
    );
    expect(findings.length).toBe(0);
  });

  test('does not run outside scripts/quality-engine/rules/', () => {
    const code = `
      import type { IRule } from "../engine";
      export const OrphanRule: IRule = { name: "z", check: () => [] };
    `;
    const findings = UnregisteredRuleExportRule.check(
      createTestSource(code, 'web/lib/some-other-file.ts')
    );
    expect(findings.length).toBe(0);
  });
});
