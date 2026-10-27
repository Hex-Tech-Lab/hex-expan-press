/**
 * Persistence rules (rules/persistence.ts), CRITICAL classification: persist paths decide whether a sale, analysis or
 * chunk is stored, so these detectors guard data integrity.
 *
 * Each test scans a realistic snippet and asserts a concrete finding or a concrete non-finding.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { IRule } from '../engine';
import {
  PersistResilienceRule,
  PersistAbortScopeRule,
  RetryFlagInterferenceRule,
  QuorumTimeoutCompletionRule,
  StaleStateResetRule,
} from '../rules/persistence';

const project = new Project({ useInMemoryFileSystem: true });

function scan(rule: IRule, filePath: string, code: string) {
  return rule.check(project.createSourceFile(filePath, code, { overwrite: true }));
}

describe('PersistResilienceRule', () => {
  test('flags a persist call with neither error state nor retry', () => {
    const findings = scan(PersistResilienceRule, 'web/components/analysis-stream.ts', [
      'export async function saveAnalysis(id: string, payload: unknown) {',
      "  return fetch('/api/analyses/persist', { method: 'POST', body: JSON.stringify({ id, payload }) });",
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Persist: No error state or retry on failure' });
  });

  test('does not flag a persist call that retries', () => {
    const findings = scan(PersistResilienceRule, 'web/components/analysis-stream.ts', [
      'const maxRetries = 2;',
      "export async function saveAnalysis(id: string) { return fetch('/api/analyses/persist', { body: id }); }",
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a persist call that propagates to the stream error state', () => {
    const findings = scan(PersistResilienceRule, 'web/components/analysis-stream.ts', [
      "export async function saveAnalysis(id: string) { try { await persistAnalysis(id); } catch { setStreamError(id); } }",
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('skips test files', () => {
    const findings = scan(PersistResilienceRule, 'web/components/analysis-stream.test.ts', [
      "export async function saveAnalysis(id: string) { return fetch('/api/analyses/persist', { body: id }); }",
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('PersistAbortScopeRule', () => {
  test('flags a persist fetch that chains the client request signal', () => {
    const findings = scan(PersistAbortScopeRule, 'web/app/api/persist/route.ts', [
      'export async function persistChunk(c: any) {',
      '  return fetch(upstream, { signal: c.req.raw.signal });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Persist: Client signal aborts server-side persist' });
  });

  test('does not flag a persist fetch bounded by a server-side timeout', () => {
    const findings = scan(PersistAbortScopeRule, 'web/app/api/persist/route.ts', [
      'export async function persistChunk() {',
      '  return fetch(upstream, { signal: AbortSignal.timeout(10000) });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('RetryFlagInterferenceRule', () => {
  test('flags a boolean attempt flag inside a retry-bearing module', () => {
    const findings = scan(RetryFlagInterferenceRule, 'web/lib/persist-loop.ts', [
      'export async function persistAll(maxRetries: number) {',
      '  let persisted = false;',
      '  for (let i = 0; i < maxRetries && !persisted; i++) { persisted = await tryWrite(); }',
      '  return persisted;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Retry: Flag may interfere with atomic-persist retry loop' });
  });

  // SILENT DEFECT (red-green): the rule's own examples are persistAttempted and hasAttempted, but the flag regex is
  // case-sensitive ("attempt" lowercase), so a camel-cased "Attempted" flag never matches and the rule stays silent.
  test('flags a persistAttempted boolean flag, as the rule documents', () => {
    const findings = scan(RetryFlagInterferenceRule, 'web/lib/atomic-persist.ts', [
      'export async function persistOnce(maxRetries: number) {',
      '  let persistAttempted = false;',
      '  if (persistAttempted) return;',
      '  persistAttempted = true;',
      '  return maxRetries;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('does not flag a bounded retry counter that starts at a number', () => {
    const findings = scan(RetryFlagInterferenceRule, 'web/lib/redis.ts', [
      'export async function run(maxRetries: number) {',
      '  for (let attempt = 0; attempt < maxRetries; attempt++) { await tick(); }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('QuorumTimeoutCompletionRule', () => {
  test('flags a quorum timeout that marks the chunks completed', () => {
    const findings = scan(QuorumTimeoutCompletionRule, 'web/lib/persist-quorum.ts', [
      'export function awaitQuorum(quorum: { status: string }) {',
      '  setTimeout(() => { quorum.status = "completed"; }, 5000);',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Persist: Quorum timeout marks incomplete chunks as completed' });
  });

  test('does not flag a quorum timeout that marks the result partial', () => {
    const findings = scan(QuorumTimeoutCompletionRule, 'web/lib/persist-quorum.ts', [
      'export function awaitQuorum(quorum: { status: string }) {',
      '  setTimeout(() => { quorum.status = "partial"; }, 5000);',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('StaleStateResetRule', () => {
  test('flags clearAnalysis nulling metadata that an eager fetch populated', () => {
    const findings = scan(StaleStateResetRule, 'web/hooks/useAnalysis.ts', [
      'export function useAnalysis(url: string) {',
      '  const clearAnalysis = () => { setVideoMetadata(null); };',
      '  useEagerVideoMetadata(url);',
      '  return clearAnalysis;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'State: clearAnalysis resets videoMetadata to null, losing eager data' });
  });

  test('does not flag clearAnalysis when no metadata is nulled', () => {
    const findings = scan(StaleStateResetRule, 'web/hooks/useAnalysis.ts', [
      'export function useAnalysis(url: string) {',
      '  const clearAnalysis = () => { setStatus("idle"); };',
      '  useEagerVideoMetadata(url);',
      '  return clearAnalysis;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});
