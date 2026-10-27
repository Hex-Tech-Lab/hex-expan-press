/**
 * Error-handling rules from rules/architecture.ts, CRITICAL classification: ErrorTaxonomyRule catches database errors
 * reported as NotFound (a failure disguised as a missing row), and WorkflowRule catches I/O without cleanup. The
 * boundary, complexity, cross-platform and schema rules in architecture.ts are NON-CRITICAL and are not covered here.
 *
 * The project skips lib loading: WorkflowRule asks for call types, and the rules here never need lib types.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { Rule, RuleContext } from '../domain/Rule';
import { ErrorTaxonomyRule, WorkflowRule } from '../rules/architecture';

const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });

function check(rule: Rule, filePath: string, code: string) {
  const sf = project.createSourceFile(filePath, code, { overwrite: true });
  const ctx: RuleContext = { filePath, ast: sf, allFiles: [filePath] };
  return rule.check(ctx);
}

describe('ErrorTaxonomyRule', () => {
  test('flags a query error collapsed into NotFound', () => {
    const findings = check(ErrorTaxonomyRule, 'web/lib/orders.ts', [
      'export async function getOrder(id: string, db: any) {',
      "  const { data, error } = await db.from('orders').select('*').eq('id', id).single();",
      "  if (error || !data) { return { kind: 'NotFound' }; }",
      '  return { kind: "Ok", data };',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Error Taxonomy: DB errors collapsed into NotFound' });
  });

  test('does not flag a missing row reported as NotFound when there is no error', () => {
    const findings = check(ErrorTaxonomyRule, 'web/lib/orders.ts', [
      'export function resolve(data: unknown) {',
      "  if (!data) { return { kind: 'NotFound' }; }",
      '  return { kind: "Ok", data };',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag an error branch that reports a server error rather than NotFound', () => {
    const findings = check(ErrorTaxonomyRule, 'web/lib/orders.ts', [
      'export function resolve(error: unknown) {',
      "  if (error) { return { kind: 'InternalError' }; }",
      '  return { kind: "Ok" };',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('WorkflowRule', () => {
  test('flags a fetch inside a try that has no finally block', () => {
    const findings = check(WorkflowRule, 'web/lib/upstream.ts', [
      'export async function load(url: string) {',
      '  try {',
      '    const res = await fetch(url);',
      '    return res;',
      "  } catch (e) { console.error('load failed', e); }",
      '}',
    ].join('\n'));
    const missing = findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe('medium');
  });

  test('does not flag a fetch whose try has a finally block', () => {
    const findings = check(WorkflowRule, 'web/lib/upstream.ts', [
      'export async function load(url: string, release: () => void) {',
      '  try {',
      '    const res = await fetch(url);',
      '    return res;',
      '  } finally { release(); }',
      '}',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(0);
  });

  test('does not treat an ordinary call as I/O', () => {
    const findings = check(WorkflowRule, 'web/lib/upstream.ts', [
      'export function label(url: string) {',
      '  return compute(url);',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});
