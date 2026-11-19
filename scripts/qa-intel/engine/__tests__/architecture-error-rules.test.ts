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
import { ComplexityRule, CrossPlatformRule, ErrorTaxonomyRule, WorkflowRule } from '../rules/architecture';

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
  test('flags a resource-holding I/O call inside a try that has no finally block', () => {
    const findings = check(WorkflowRule, 'web/lib/upstream.ts', [
      'export async function load(path: string, data: string) {',
      '  try {',
      '    const res = await writeFile(path, data);',
      '    return res;',
      "  } catch (e) { console.error('load failed', e); }",
      '}',
    ].join('\n'));
    const missing = findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe('medium');
  });

  // Triage item 3 negative controls: RegExp.prototype.exec and fetch hold no resource that a finally would release.
  test('does not flag RegExp.exec as child_process exec', () => {
    const findings = check(WorkflowRule, 'scripts/scan.ts', [
      'export function scan(text: string) {',
      '  const out: string[] = [];',
      '  try {',
      '    const m = /a(b)/.exec(text);',
      '    if (m) out.push(m[1]!);',
      '  } catch (e) { console.error(e); }',
      '  return out;',
      '}',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(0);
  });

  test('does not ask for a finally block around a bare fetch', () => {
    const findings = check(WorkflowRule, 'scripts/fetch.ts', [
      'export async function load(url: string) {',
      '  for (let i = 0; i < 3; i++) {',
      '    const res = await fetch(url);',
      '    if (res.ok) return res;',
      '  }',
      '}',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(0);
  });

  test('flags exec imported from child_process, bare or through a namespace', () => {
    const bare = check(WorkflowRule, 'scripts/run.ts', [
      "import { exec } from 'node:child_process';",
      'export function run(cmd: string) {',
      '  exec(cmd);',
      '}',
    ].join('\n'));
    expect(bare.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(1);
    const ns = check(WorkflowRule, 'scripts/run.ts', [
      "import * as cp from 'child_process';",
      'export function run(cmd: string) {',
      '  cp.exec(cmd);',
      '}',
    ].join('\n'));
    expect(ns.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(1);
  });

  test('does not flag synchronous execSync in a try with no finally block (holds no open handle)', () => {
    const findings = check(WorkflowRule, 'scripts/run-sync.ts', [
      "import { execSync } from 'node:child_process';",
      'export function run(cmd: string) {',
      '  try {',
      '    return execSync(cmd);',
      '  } catch (e) { console.error(e); }',
      '}',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(0);
  });

  // R6: child_process loaded with require() is still child_process.
  test('flags exec from a child_process namespace loaded with require', () => {
    const findings = check(WorkflowRule, 'scripts/run-require.ts', [
      "const cp = require('node:child_process');",
      'export function run(cmd: string) {',
      '  try {',
      '    cp.exec(cmd);',
      '  } catch (e) { console.error(e); }',
      '}',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(1);
  });

  test('flags exec destructured from a require of child_process', () => {
    const findings = check(WorkflowRule, 'scripts/run-destructure.ts', [
      "const { exec: run } = require('child_process');",
      'export function go(cmd: string) {',
      '  try {',
      '    run(cmd);',
      '  } catch (e) { console.error(e); }',
      '}',
    ].join('\n'));
    expect(findings.filter((f) => f.title === 'Workflow: Missing finally block for I/O')).toHaveLength(1);
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

describe('CrossPlatformRule (LF-only split)', () => {
  const lfFindings = (code: string) =>
    check(CrossPlatformRule, 'scripts/lines.ts', code).filter((f) => f.title === 'Cross-Platform: LF-only string splitting');

  test('flags an LF split of text read from disk', () => {
    const findings = lfFindings([
      "import fs from 'node:fs';",
      'export function lines(p: string) {',
      "  const raw = fs.readFileSync(p, 'utf8');",
      "  return raw.split('\\n');",
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.why).toContain('1 instance(s)');
  });

  // CRLF platforms leave a trailing \r on the first line of raw error or subprocess text.
  test('flags an LF split of a raw error message, which keeps a CR on CRLF output', () => {
    expect(lfFindings([
      'export function summary(err: Error) {',
      '  return err.message.split("\\n")[0];',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  test('does not flag an LF split of an error message after CR normalization', () => {
    expect(lfFindings([
      'export function summary(err: Error) {',
      '  return err.message.replace(/\\r/g, "").split("\\n")[0];',
      '}',
    ].join('\n'))).toHaveLength(0);
  });

  // Triage item 10 negative controls.
  test('does not flag a split whose first element is trimmed', () => {
    expect(lfFindings([
      'export function id(card: string) {',
      '  return card.split("\\n")[0].trim();',
      '}',
    ].join('\n'))).toHaveLength(0);
  });

  test('does not flag a split whose every line is trimmed by a map', () => {
    expect(lfFindings([
      'export function rows(text: string) {',
      '  return text.split("\\n").map((l) => l.trim());',
      '}',
    ].join('\n'))).toHaveLength(0);
  });

  test('does not flag a split of text the code built itself', () => {
    expect(lfFindings([
      'export function reparse(parts: string[]) {',
      '  const joined = parts.join("\\n");',
      '  return joined.split("\\n");',
      '}',
      'export const inline = ["a", "b"].join("\\n").split("\\n");',
      'export const literal = "a\\nb".split("\\n");',
    ].join('\n'))).toHaveLength(0);
  });

  // R6: a template with an interpolation and a reassigned let hold text this file did not build.
  test('flags an LF split of a template that interpolates text read from disk', () => {
    expect(lfFindings([
      "import fs from 'node:fs';",
      'export function lines(p: string) {',
      "  const text = `${fs.readFileSync(p, 'utf8')}`;",
      '  return text.split("\\n");',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  test('flags an LF split of a let that is reassigned from disk', () => {
    expect(lfFindings([
      "import fs from 'node:fs';",
      'export function lines(p: string) {',
      '  let text = "";',
      "  text = fs.readFileSync(p, 'utf8');",
      '  return text.split("\\n");',
      '}',
    ].join('\n'))).toHaveLength(1);
  });

  test('skips test files and NDJSON JSON.parse splits, but reports raw stderr and error-message splits', () => {
    const testFile = check(CrossPlatformRule, 'scripts/__tests__/bash.test.ts', [
      'export function parse(out: string) { return out.split("\\n"); }',
    ].join('\n'));
    expect(testFile).toHaveLength(0);

    // Raw subprocess and error text keeps a trailing \r on CRLF platforms, so these splits are reported.
    expect(lfFindings([
      'export function errLine(e: unknown, stderr: string) {',
      '  return stderr.split("\\n").pop() ?? (e instanceof Error ? e.message.split("\\n")[0] : "");',
      '}',
    ].join('\n'))).toHaveLength(1);

    expect(lfFindings([
      'export function readNdjson(raw: string) {',
      '  const lines = raw.trim().split("\\n").filter(Boolean);',
      '  return lines.map((l) => JSON.parse(l));',
      '}',
    ].join('\n'))).toHaveLength(0);
  });
});

describe('ComplexityRule', () => {
  test('flags a >500-line production file and skips a >500-line test file', () => {
    const longCode = Array.from({ length: 505 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    expect(check(ComplexityRule, 'scripts/big.ts', longCode)).toHaveLength(1);
    expect(check(ComplexityRule, 'scripts/__tests__/big.test.ts', longCode)).toHaveLength(0);
  });
});
