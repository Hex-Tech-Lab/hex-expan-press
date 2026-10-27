/**
 * Error-handling rules from rules/ui.ts, CRITICAL classification: UnhandledClipboardPromiseRule and SwallowedErrorRule
 * detect rejections and errors that disappear without a trace. The INP and accessibility rules in ui.ts are
 * NON-CRITICAL and are not covered here.
 *
 * Each test asserts a concrete finding or a concrete non-finding on a realistic snippet.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { IRule } from '../engine';
import { UnhandledClipboardPromiseRule, SwallowedErrorRule } from '../rules/ui';

const project = new Project({ useInMemoryFileSystem: true });

function scan(rule: IRule, filePath: string, code: string) {
  return rule.check(project.createSourceFile(filePath, code, { overwrite: true }));
}

describe('UnhandledClipboardPromiseRule', () => {
  test('flags a clipboard write whose rejection nothing handles', () => {
    const findings = scan(UnhandledClipboardPromiseRule, 'web/components/CopyButton.tsx', [
      'export function CopyButton({ text }: { text: string }) {',
      '  return <button onClick={() => { navigator.clipboard.writeText(text); }}>Copy</button>;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', title: 'Promise: Unhandled clipboard promise rejection' });
  });

  test('does not flag a clipboard write that chains a .catch', () => {
    const findings = scan(UnhandledClipboardPromiseRule, 'web/components/CopyButton.tsx', [
      'export function copy(text: string) {',
      '  navigator.clipboard.writeText(text).catch(() => {});',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a clipboard write inside a try that has a catch', () => {
    const findings = scan(UnhandledClipboardPromiseRule, 'web/components/CopyButton.tsx', [
      'export async function copy(text: string) {',
      '  try { await navigator.clipboard.writeText(text); } catch (e) { toast(String(e)); }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  // SILENT DEFECT (red-green): any enclosing try counts as handling, but a try with only a finally does not catch the
  // rejection, so the permission-denied rejection reaches the console unhandled and the rule stays silent.
  test('flags a clipboard write inside a try that has only a finally block', () => {
    const findings = scan(UnhandledClipboardPromiseRule, 'web/components/CopyButton.tsx', [
      'export async function copy(text: string) {',
      '  try { await navigator.clipboard.writeText(text); } finally { setBusy(false); }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  // SILENT DEFECT (red-green): the ancestor-catch test treats a clipboard call inside a catch body as handled, but an
  // exception thrown from a catch clause is not caught by that same clause.
  test('flags a clipboard write made inside a catch body, where no catch covers it', () => {
    const findings = scan(UnhandledClipboardPromiseRule, 'web/components/CopyButton.tsx', [
      'export async function copy(task: () => Promise<void>) {',
      '  try { await task(); } catch (e) { await navigator.clipboard.writeText(String(e)); }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('does nothing when the file never touches navigator.clipboard', () => {
    const findings = scan(UnhandledClipboardPromiseRule, 'web/components/Other.tsx', [
      'export function save(writer: { writeText(s: string): void }) { writer.writeText("x"); }',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('SwallowedErrorRule', () => {
  test('flags an empty catch block as a high-severity swallowed error', () => {
    const findings = scan(SwallowedErrorRule, 'web/lib/persist.ts', [
      'export async function persist(run: () => Promise<void>) {',
      '  try { await run(); } catch (e) {}',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Error: Empty catch block swallows error silently' });
  });

  test('does not flag a catch that logs the error', () => {
    const findings = scan(SwallowedErrorRule, 'web/lib/persist.ts', [
      'export async function persist(run: () => Promise<void>) {',
      "  try { await run(); } catch (e) { console.error('[persist]', e); }",
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  // SILENT DEFECT (red-green, over-firing): the rule computes hasOnlyComments from block.getFullText(), which still
  // contains the braces, so the all-comment exemption can never match and a deliberately documented catch is flagged
  // as a silent swallow. The exemption is dead code as written.
  test('does not flag a catch whose only content is an explanatory comment', () => {
    const findings = scan(SwallowedErrorRule, 'web/lib/cache.ts', [
      'export async function clearCache(clear: () => Promise<void>) {',
      '  try { await clear(); } catch (e) {',
      '    // a miss is expected when the key was never written',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});
