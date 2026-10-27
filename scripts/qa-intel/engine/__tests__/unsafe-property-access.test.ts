/**
 * UnsafePropertyAccessRule flags an array index 0 or 1 in an I/O-looking function when no guard is visible.
 * The rule was silent until the port fixed the ts-morph call that threw inside its try block, so these tests
 * pin both the detection and the explicit-guard exemption that the rule needs to avoid false positives.
 */

import { test, describe, expect } from 'vitest';
import { Project } from 'ts-morph';
import { UnsafePropertyAccessRule } from '../rules/security';
import type { SourceFile } from 'ts-morph';

function createTestSource(code: string, path = 'src/parse-thing.ts'): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(path, code);
}

describe('UnsafePropertyAccessRule', () => {
  test('flags an index access in a parse function with no guard', () => {
    const code = `
      export function parseThing(raw: string) {
        const parts = raw.split(".");
        return parts[0];
      }
    `;
    expect(UnsafePropertyAccessRule.check(createTestSource(code))).toHaveLength(1);
  });

  test('does not flag an index access that an earlier length check guards', () => {
    const code = `
      export function parseThing(raw: string) {
        const parts = raw.split(".");
        if (parts.length !== 3) return null;
        return parts[0];
      }
    `;
    expect(UnsafePropertyAccessRule.check(createTestSource(code))).toHaveLength(0);
  });

  test('does not flag an index access after a multi-part check that tests the same array', () => {
    const code = `
      export function parseThing(consents: string[]) {
        const heads = consents.filter((c) => c.length > 0);
        if (heads.length !== 1 || consents.length === 0) {
          throw new Error("bad");
        }
        return heads[0];
      }
    `;
    expect(UnsafePropertyAccessRule.check(createTestSource(code))).toHaveLength(0);
  });

  test('does not flag an access inside the branch that its own truthiness check opens', () => {
    const code = `
      export function parseThing(raw: string) {
        const bracketed = /^\\[([^\\]]+)\\]$/.exec(raw);
        if (bracketed) {
          return bracketed[1];
        }
        return null;
      }
    `;
    expect(UnsafePropertyAccessRule.check(createTestSource(code))).toHaveLength(0);
  });

  test('still flags when the earlier check tests a different array', () => {
    const code = `
      export function parseThing(raw: string, other: string[]) {
        const parts = raw.split(".");
        if (other.length !== 3) return null;
        return parts[0];
      }
    `;
    expect(UnsafePropertyAccessRule.check(createTestSource(code))).toHaveLength(1);
  });

  test('still flags when the only check on the array comes after the access', () => {
    const code = `
      export function parseThing(raw: string) {
        const parts = raw.split(".");
        const first = parts[0];
        if (parts.length !== 3) return null;
        return first;
      }
    `;
    expect(UnsafePropertyAccessRule.check(createTestSource(code))).toHaveLength(1);
  });

  test('does not flag index 0 of a split result, which always has at least one element', () => {
    const code = `
      export function parseIp(raw: string) {
        return parseHost(raw.split(",")[0]);
      }
    `;
    expect(UnsafePropertyAccessRule.check(createTestSource(code))).toHaveLength(0);
  });

  test('skips test files', () => {
    const code = `export function parseThing(raw: string) { return raw.split(".")[0]; }`;
    expect(UnsafePropertyAccessRule.check(createTestSource(code, 'src/parse-thing.test.ts'))).toHaveLength(0);
  });
});
