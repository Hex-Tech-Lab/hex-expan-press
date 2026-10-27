/**
 * Error-handling and coercion rules from rules/quality.ts, CRITICAL classification: ErrorObservabilityRule and
 * ErrorNormalizationRule detect silent failures; TimeoutCleanupRule detects leaked timers; NumberCoercionGuardRule
 * detects Number(null) returning a silent 0. The other rules in quality.ts (naming, dead code, import order, async
 * keyword) are NON-CRITICAL and are not covered here.
 *
 * Each test asserts a concrete finding or a concrete non-finding on a realistic snippet.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { IRule } from '../engine';
import {
  ErrorObservabilityRule,
  ErrorNormalizationRule,
  TimeoutCleanupRule,
  NumberCoercionGuardRule,
} from '../rules/quality';

const project = new Project({ useInMemoryFileSystem: true });

function scan(rule: IRule, filePath: string, code: string) {
  return rule.check(project.createSourceFile(filePath, code, { overwrite: true }));
}

describe('ErrorObservabilityRule', () => {
  test('flags an empty catch block as a high-severity silent failure', () => {
    const findings = scan(ErrorObservabilityRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) {}',
      '}',
    ].join('\n'));
    const silent = findings.filter((f) => f.title === 'Observability: Empty catch block (silent failure)');
    expect(silent).toHaveLength(1);
    expect(silent[0]?.severity).toBe('high');
  });

  test('flags a catch that neither logs nor reports', () => {
    const findings = scan(ErrorObservabilityRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) { cleanup(); }',
      '}',
    ].join('\n'));
    const unlogged = findings.filter((f) => f.title === 'Observability: Catch block without error logging');
    expect(unlogged).toHaveLength(1);
    expect(unlogged[0]?.severity).toBe('medium');
  });

  test('does not flag a catch that logs through console', () => {
    const findings = scan(ErrorObservabilityRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      "  try { await run(); } catch (err) { console.error('[sync]', err); }",
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a catch that reports to Sentry', () => {
    const findings = scan(ErrorObservabilityRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) { Sentry.captureException(err); }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  // SILENT DEFECT (red-green): hasObservability is a substring test over the raw catch text, so the words
  // "console." or "Sentry." inside a comment or a string literal count as logging. This catch swallows the error and
  // the rule reports nothing.
  test('flags a catch whose only mention of logging is inside a comment', () => {
    const findings = scan(ErrorObservabilityRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) {',
      '    // console.error is wired up in the logger module later',
      '  }',
      '}',
    ].join('\n'));
    const unlogged = findings.filter((f) => f.title === 'Observability: Catch block without error logging');
    expect(unlogged).toHaveLength(1);
  });

  test('flags a catch whose only mention of Sentry is a status-label string', () => {
    const findings = scan(ErrorObservabilityRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) { setStatus("Sentry. unavailable"); }',
      '}',
    ].join('\n'));
    const unlogged = findings.filter((f) => f.title === 'Observability: Catch block without error logging');
    expect(unlogged).toHaveLength(1);
  });
});

describe('ErrorNormalizationRule', () => {
  test('flags a raw caught value forwarded to Sentry without normalization', () => {
    const findings = scan(ErrorNormalizationRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) { Sentry.captureException(err); }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', title: "Code Quality: Catch variable 'err' forwarded without normalization" });
  });

  test('flags a raw caught value that is rethrown without normalization', () => {
    const findings = scan(ErrorNormalizationRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) { throw err; }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('does not flag a caught value narrowed with instanceof Error before it is forwarded', () => {
    const findings = scan(ErrorNormalizationRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      '  try { await run(); } catch (err) {',
      '    Sentry.captureException(err instanceof Error ? err : new Error(String(err)));',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a catch that forwards only the message property', () => {
    const findings = scan(ErrorNormalizationRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      "  try { await run(); } catch (err) { console.error('sync failed', err.message); }",
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not run on a catch with no binding', () => {
    const findings = scan(ErrorNormalizationRule, 'web/lib/sync.ts', [
      'export async function sync(run: () => Promise<void>) {',
      "  try { await run(); } catch { Sentry.captureException(new Error('sync')); }",
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('TimeoutCleanupRule', () => {
  test('flags a timer handle that is never cleared', () => {
    const findings = scan(TimeoutCleanupRule, 'web/lib/poll.ts', [
      'export function startPolling(poll: () => void) {',
      '  const retryTimer = setTimeout(poll, 1000);',
      '  return retryTimer;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', title: "Resource Leak: Timer handle 'retryTimer' not cleared" });
  });

  test('does not flag an interval that is cleared with clearInterval', () => {
    const findings = scan(TimeoutCleanupRule, 'web/lib/poll.ts', [
      'export function startPolling(poll: () => void) {',
      '  const tick = setInterval(poll, 500);',
      '  return () => clearInterval(tick);',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('skips quality-engine test files, which embed bad code as template text', () => {
    const findings = scan(TimeoutCleanupRule, 'scripts/quality-engine/rules.test.ts', [
      "const code = 'const timerId = setTimeout(run, 10)';",
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('NumberCoercionGuardRule', () => {
  test('flags Number applied to an unguarded query parameter', () => {
    const findings = scan(NumberCoercionGuardRule, 'web/app/api/list/route.ts', [
      'export function limitFrom(query: { limit?: string | null }) {',
      '  const limit = Number(query.limit);',
      '  return limit;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', title: "Code Quality: Unguarded 'Number(query.limit)' coercion" });
  });

  test('does not flag Number applied to a numeric literal', () => {
    const findings = scan(NumberCoercionGuardRule, 'web/app/api/list/route.ts', 'const fallback = Number(42);');
    expect(findings).toHaveLength(0);
  });

  test('does not flag Number guarded by a typeof check in the same statement', () => {
    const findings = scan(NumberCoercionGuardRule, 'web/app/api/list/route.ts', [
      'export function limitFrom(raw: unknown) {',
      "  const limit = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : 20;",
      '  return limit;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a Number call with more than one argument', () => {
    const findings = scan(NumberCoercionGuardRule, 'web/app/api/list/route.ts', 'const pair = Number(a, b);');
    expect(findings).toHaveLength(0);
  });
});
