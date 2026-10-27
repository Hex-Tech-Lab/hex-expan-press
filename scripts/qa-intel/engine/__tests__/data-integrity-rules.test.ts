/**
 * Data-integrity rules (rules/data-integrity.ts), CRITICAL classification.
 *
 * Each test scans a realistic snippet and asserts a concrete finding or a concrete non-finding.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { IRule } from '../engine';
import {
  DatabaseConstraintRule,
  DefaultValueConsistencyRule,
  TruncationValidationRule,
} from '../rules/data-integrity';

const project = new Project({ useInMemoryFileSystem: true });

function scan(rule: IRule, filePath: string, code: string) {
  return rule.check(project.createSourceFile(filePath, code, { overwrite: true }));
}

const MIGRATION = 'supabase/migrations/20261001000000_orders.sql';
const SCHEMA = 'supabase/schema/flags.sql';

describe('DatabaseConstraintRule', () => {
  test('flags a count column with no constraint in a CREATE TABLE migration', () => {
    const findings = scan(DatabaseConstraintRule, MIGRATION, [
      'CREATE TABLE orders (',
      '  id UUID PRIMARY KEY,',
      '  ticket_count INT,',
      '  status TEXT NOT NULL',
      ');',
    ].join('\n'));
    const numeric = findings.filter((f) => f.title.startsWith('Data Integrity: Missing constraints on numeric'));
    expect(numeric).toHaveLength(1);
    expect(numeric[0]).toMatchObject({ severity: 'medium', title: "Data Integrity: Missing constraints on numeric column 'ticket_count'" });
  });

  test('does not flag a count column that carries a CHECK constraint', () => {
    const findings = scan(DatabaseConstraintRule, MIGRATION, [
      'CREATE TABLE orders (',
      '  ticket_count INT NOT NULL CHECK (ticket_count >= 0),',
      ');',
    ].join('\n'));
    expect(findings.filter((f) => f.title.includes('numeric column'))).toHaveLength(0);
  });

  test('does not flag a numeric column whose name does not suggest a constrained quantity', () => {
    const findings = scan(DatabaseConstraintRule, MIGRATION, [
      'CREATE TABLE menu (',
      '  sort_order INT,',
      ');',
    ].join('\n'));
    expect(findings.filter((f) => f.title.includes('numeric column'))).toHaveLength(0);
  });

  test('flags a key-like text column that allows NULL', () => {
    const findings = scan(DatabaseConstraintRule, MIGRATION, [
      'CREATE TABLE sessions (',
      '  user_id TEXT,',
      '  status TEXT,',
      ');',
    ].join('\n'));
    const notNull = findings.filter((f) => f.title.startsWith('Data Integrity: Missing NOT NULL'));
    expect(notNull.map((f) => f.title)).toEqual(expect.arrayContaining([
      "Data Integrity: Missing NOT NULL on key column 'user_id'",
      "Data Integrity: Missing NOT NULL on key column 'status'",
    ]));
  });

  test('does not flag a key-like text column declared NOT NULL', () => {
    const findings = scan(DatabaseConstraintRule, MIGRATION, [
      'CREATE TABLE sessions (',
      '  user_id TEXT NOT NULL,',
      '  status TEXT NOT NULL,',
      ');',
    ].join('\n'));
    expect(findings.filter((f) => f.title.includes('NOT NULL'))).toHaveLength(0);
  });

  test('flags a TypeScript insert with no validation in the enclosing function', () => {
    const findings = scan(DatabaseConstraintRule, 'src/billing/orders.ts', [
      'export function createOrder(db: any, input: { amount: number }) {',
      "  return db.insert('orders', input);",
      '}',
    ].join('\n'));
    const unvalidated = findings.filter((f) => f.title === 'Data Integrity: DB operation without validation');
    expect(unvalidated).toHaveLength(1);
    expect(unvalidated[0]?.severity).toBe('high');
  });

  test('flags a supabase update inside an arrow function with no validation', () => {
    const findings = scan(DatabaseConstraintRule, 'src/billing/save.ts', [
      'export const saveOrder = async (row: { id: string }) => supabase.from("orders").update(row);',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Data Integrity: DB operation without validation')).toHaveLength(1);
  });

  test('does not flag a database write whose function validates the input first', () => {
    const findings = scan(DatabaseConstraintRule, 'src/billing/orders.ts', [
      'export function createOrder(db: any, input: unknown) {',
      '  const row = validate(input);',
      "  return db.insert('orders', row);",
      '}',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Data Integrity: DB operation without validation')).toHaveLength(0);
  });

  test('does not run the TypeScript write check on test files', () => {
    const findings = scan(DatabaseConstraintRule, 'src/billing/orders.test.ts', [
      'export function seed(db: any, input: unknown) {',
      "  return db.insert('orders', input);",
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('DefaultValueConsistencyRule', () => {
  test('flags boolean false defaulted both as the keyword and as the string', () => {
    const findings = scan(DefaultValueConsistencyRule, SCHEMA, [
      'CREATE TABLE flags (',
      '  is_active BOOLEAN DEFAULT false,',
      "  is_beta BOOLEAN DEFAULT 'false'",
      ');',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', title: 'Data Integrity: Inconsistent DEFAULT values (boolean vs string)' });
  });

  test('flags boolean true defaulted both as the keyword and as the string', () => {
    const findings = scan(DefaultValueConsistencyRule, SCHEMA, [
      'CREATE TABLE flags (',
      '  is_active BOOLEAN DEFAULT true,',
      "  is_public BOOLEAN DEFAULT 'true'",
      ');',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('flags a NOT NULL column that also declares DEFAULT NULL', () => {
    const findings = scan(DefaultValueConsistencyRule, MIGRATION, [
      'CREATE TABLE plans (',
      '  plan_id TEXT NOT NULL DEFAULT NULL,',
      ');',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('Data Integrity: Column with NOT NULL and DEFAULT NULL');
  });

  test('does not flag consistent boolean defaults', () => {
    const findings = scan(DefaultValueConsistencyRule, SCHEMA, [
      'CREATE TABLE flags (',
      '  is_active BOOLEAN DEFAULT false,',
      '  is_beta BOOLEAN DEFAULT false',
      ');',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not run outside migration or schema paths', () => {
    const findings = scan(DefaultValueConsistencyRule, 'src/flags.sql', [
      'CREATE TABLE flags (',
      '  is_active BOOLEAN DEFAULT false,',
      "  is_beta BOOLEAN DEFAULT 'false'",
      ');',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('TruncationValidationRule', () => {
  test('flags a string slice that drops text without an ellipsis', () => {
    const findings = scan(TruncationValidationRule, 'web/lib/preview.ts', [
      'export function preview(body: string) {',
      '  const excerpt = body.slice(0, 80);',
      '  return excerpt;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'low', title: 'Data Quality: String truncation without ellipsis indicator' });
  });

  test('does not flag a slice whose result gets an ellipsis appended', () => {
    const findings = scan(TruncationValidationRule, 'web/lib/preview.ts', [
      'export function preview(body: string) {',
      "  const excerpt = body.slice(0, 80) + '...';",
      '  return excerpt;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('flags substring and substr truncations', () => {
    const findings = scan(TruncationValidationRule, 'web/lib/labels.ts', [
      'export function labels(name: string, raw: string) {',
      '  const label = name.substring(0, 24);',
      '  const code = raw.substr(0, 8);',
      '  return [label, code];',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(2);
  });

  test('does not flag slice(0, -1), which drops a trailing character rather than truncating for display', () => {
    const findings = scan(TruncationValidationRule, 'web/lib/url.ts', [
      'export function trimTrailingDot(url: string) {',
      '  const trimmed = url.slice(0, -1);',
      '  return trimmed;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag Array.prototype.slice over an array', () => {
    const findings = scan(TruncationValidationRule, 'web/lib/top.ts', [
      'export function top(items: string[]) {',
      '  const first = items.slice(0, 3);',
      '  return first;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a function that is merely named like a slice', () => {
    const findings = scan(TruncationValidationRule, 'web/lib/digest.ts', [
      'declare function sliceDigest(raw: string): string;',
      'export function digest(raw: string) {',
      '  const d = sliceDigest(raw);',
      '  return d;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});
