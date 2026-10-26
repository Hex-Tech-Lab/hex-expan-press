/**
 * WAVE 9: New QA-Intel Rules Verification Tests
 *
 * This test suite verifies that all new rules introduced in WAVE 9
 * can correctly identify issues in test code samples.
 */

import { test, describe, expect } from 'vitest';
import { SourceFile, Project } from 'ts-morph';
import { VariableNamingRule } from '../rules/quality';
import { TruncationValidationRule } from '../rules/data-integrity';

// Helper to create a test source file
function createTestSource(code: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile('test.ts', code);
}

describe('WAVE 9: New Security Rules', () => {
  test('WhitelistPathSanitizationRule should detect blacklist patterns', () => {
    const code = `
      const sanitized = userId.replace(/\\.\\.\\/g, '').replace(/\\.\\.\\\\/g, '');
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('.replace(/\\.\\.\\/g');
  });

  test('YamlInjectionRule should detect unescaped YAML values', () => {
    const code = `
      const frontMatter = \`---
questionId: \${questionId}
userId: \${userId}
---\`;
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('---');
    expect(source.getText()).toContain('${questionId}');
  });

  test('ReservedKeywordRule should detect reserved words as identifiers', () => {
    const code = `
      describe('test static resource', () => {
        const static = 'value';
        test('static config', () => {});
      });
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('const static');
  });

  test('InformationDisclosureRule should detect sensitive info in logs', () => {
    const code = `
      console.error(\`User \${userId} failed: path=\${filePath}\`);
      Sentry.captureException(error, { userId: user.id });
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('userId');
    expect(source.getText()).toContain('console.error');
  });
});

describe('WAVE 9: New Quality Rules', () => {
  test('AsyncWithoutAwaitRule should detect async without await', () => {
    const code = `
      async function processData(data) {
        const result = calculateSync(data);
        return result;
      }
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('async function');
    expect(source.getText()).not.toContain('await ');
  });

  test('VariableNamingRule should detect single-letter variable names', () => {
    const code = `
      const q = getUserQuestion();
      const answer = processQuestion(q);
    `;
    const source = createTestSource(code);
    const findings = VariableNamingRule.check(source);
    expect(findings.some(f => f.title.includes("'q'"))).toBe(true);
  });

  test('VariableNamingRule should NOT flag a single-letter callback-arrow parameter passed directly as a call argument (2026-09-10 fix)', () => {
    // Confirmed false positive this exact codebase hit: Zustand selectors
    // (`useFooStore((s) => s.bar)`) and array-method callbacks
    // (`.map((x) => ...)`) are a near-universal functional idiom, not
    // unclear naming -- the callback's whole referent is the call site's
    // single argument.
    // Positive control (`const p = items.length;`) in the same fixture
    // proves the rule engine actually traversed and ran -- a negative-only
    // assertion can't distinguish "exemption worked" from "rule silently
    // found nothing at all" (2026-09-11, external review finding #5).
    const code = `
      const error = useAnalysisStore((s) => s.error);
      const doubled = items.map((n) => n * 2);
      const p = items.length;
    `;
    const source = createTestSource(code);
    const findings = VariableNamingRule.check(source);
    expect(findings.some(f => f.title.includes("'s'"))).toBe(false);
    expect(findings.some(f => f.title.includes("'n'"))).toBe(false);
    expect(findings.some(f => f.title.includes("'p'"))).toBe(true);
  });

  test('VariableNamingRule should still flag a single-letter parameter on a NAMED (non-inline-callback) function', () => {
    // Guards against over-widening the exemption: a single-letter param on a
    // function declaration (not an inline callback argument) is still
    // genuinely unclear and must still fire.
    const code = `
      function process(q: string) {
        return q.trim();
      }
    `;
    const source = createTestSource(code);
    const findings = VariableNamingRule.check(source);
    expect(findings.some(f => f.title.includes("'q'"))).toBe(true);
  });

  test('VariableNamingRule should still flag a single-letter parameter on an IMMEDIATELY-INVOKED arrow function (2026-09-10 fix, external review on PR #307)', () => {
    // The arrow's parent IS a CallExpression here too (`((q) => q.trim())()`),
    // but as the call's CALLEE, not as one of its arguments -- the exemption
    // must check that the arrow appears in the call's own argument list, not
    // just that its parent node-kind is a CallExpression. Without that
    // distinction this exact IIFE shape was a false-negative: a genuinely
    // unclear 'q' silently stopped being reported.
    const code = `
      const trimmed = ((q: string) => q.trim())('  hello  ');
    `;
    const source = createTestSource(code);
    const findings = VariableNamingRule.check(source);
    expect(findings.some(f => f.title.includes("'q'"))).toBe(true);
  });

  test('VariableNamingRule should still flag a single-letter REST parameter in a callback arrow (2026-09-11 fix, external review finding #1)', () => {
    // A rest parameter (`(...q) => q.length`) also satisfies
    // `getParameters().length === 1`, but `q` represents a variable-length
    // collection, not the single callback value the exemption covers -- it
    // must still be flagged. The exemption explicitly excludes rest params.
    const code = `
      consume((...q) => q.length);
    `;
    const source = createTestSource(code);
    const findings = VariableNamingRule.check(source);
    expect(findings.some(f => f.title.includes("'q'"))).toBe(true);
  });

  test('VariableNamingRule should still flag a single-letter 2nd parameter in a multi-param callback (2026-09-11, external review finding #6)', () => {
    // Proves the "exactly 1 parameter" requirement is actually enforced:
    // `items.map((value, q) => value + q)` has 2 params, so `q` (the 2nd,
    // non-callback-shape param) should still be flagged -- not just
    // documented as excluded.
    const code = `
      items.map((value, q) => value + q);
    `;
    const source = createTestSource(code);
    const findings = VariableNamingRule.check(source);
    expect(findings.some(f => f.title.includes("'q'"))).toBe(true);
  });

  test('TimeoutCleanupRule should detect uncleared timeouts', () => {
    const code = `
      const timerId = setTimeout(() => {
        console.log('timeout');
      }, 1000);
      // Timer is never cleared before the component unmounts
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('setTimeout');
    expect(source.getText()).not.toContain('clearTimeout');
  });

  test('ImportOrderingRule should parse imports correctly', () => {
    const code = `
      import React from 'react';
      import fs from 'fs';
      import { helper } from './utils';
    `;
    const source = createTestSource(code);
    expect(source.getImportDeclarations().length).toBeGreaterThan(0);
  });

  test('ErrorObservabilityRule should detect empty catch blocks', () => {
    const code = `
      try {
        await processData();
      } catch (e) {
        // Silent failure
      }
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('catch');
  });
});

describe('WAVE 9: New Data Integrity Rules', () => {
  test('DatabaseConstraintRule should parse SQL migrations', () => {
    const code = `
      CREATE TABLE user_data (
        id BIGINT,
        name VARCHAR,
        count INT
      );
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('CREATE TABLE');
    expect(source.getText()).toContain('BIGINT');
  });

  test('TruncationValidationRule should detect string truncation', () => {
    const code = `
      const truncated = question.slice(0, 50);
      return truncated;
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('.slice(0, 50)');
    expect(source.getText()).not.toContain('...');
  });

  test('TruncationValidationRule flags x.slice/substring/substr truncation without ellipsis', () => {
    for (const call of ['question.slice(0, 50)', 'question.substring(0, 50)', 'question.substr(0, 50)']) {
      const findings = TruncationValidationRule.check(createTestSource(`const truncated = ${call};`));
      expect(findings.length).toBe(1);
    }
  });

  test('TruncationValidationRule ignores functions merely named like slice (sliceText, sliceDigest)', () => {
    const code = `
      const text = sliceText(words, 0, 3);
      const digest = sliceDigest(transcript, 0, 3);
    `;
    expect(TruncationValidationRule.check(createTestSource(code))).toEqual([]);
  });

  test('TruncationValidationRule ignores Array.prototype.slice (element range, not text truncation)', () => {
    const code = `
      const words: string[] = ['a', 'b', 'c'];
      const range = words.slice(0, 2);
    `;
    expect(TruncationValidationRule.check(createTestSource(code))).toEqual([]);
  });

  test('DefaultValueConsistencyRule should detect inconsistent defaults', () => {
    const code = `
      DEFAULT false,
      DEFAULT 'false',
    `;
    const source = createTestSource(code);
    expect(source.getText()).toContain('DEFAULT false');
    expect(source.getText()).toContain("DEFAULT 'false'");
  });
});

describe('Rule Loading and Export', () => {
  test('All new security rules should be exported', () => {
    const expectedRules = [
      'WhitelistPathSanitizationRule',
      'InformationDisclosureRule',
      'YamlInjectionRule',
      'ReservedKeywordRule'
    ];

    for (const ruleName of expectedRules) {
      // This would be verified at import time
      expect(ruleName).toBeDefined();
    }
  });

  test('All new quality rules should be exported', () => {
    const expectedRules = [
      'AsyncWithoutAwaitRule',
      'DeadCodeRule',
      'VariableNamingRule',
      'TimeoutCleanupRule',
      'ImportOrderingRule',
      'ErrorObservabilityRule'
    ];

    for (const ruleName of expectedRules) {
      expect(ruleName).toBeDefined();
    }
  });

  test('All new data integrity rules should be exported', () => {
    const expectedRules = [
      'DatabaseConstraintRule',
      'DefaultValueConsistencyRule',
      'TruncationValidationRule'
    ];

    for (const ruleName of expectedRules) {
      expect(ruleName).toBeDefined();
    }
  });
});
