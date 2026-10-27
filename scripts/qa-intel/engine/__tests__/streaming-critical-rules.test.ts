/**
 * Critical rules from rules/streaming.ts: StreamSettleRule (parallel SSE streams without a per-stream abort, which can
 * hang) and ProxyPromotionRule (the residential proxy credential handled outside the secret store). The prompt and
 * cascade rules in streaming.ts are NON-CRITICAL and are not covered here.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { Rule, RuleContext } from '../domain/Rule';
import { StreamSettleRule, ProxyPromotionRule } from '../rules/streaming';

const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });

function check(rule: Rule, filePath: string, code: string) {
  const sf = project.createSourceFile(filePath, code, { overwrite: true });
  const ctx: RuleContext = { filePath, ast: sf, allFiles: [filePath] };
  return rule.check(ctx);
}

describe('StreamSettleRule', () => {
  const hook = 'web/hooks/useSSEStream.ts';

  test('flags parallel SSE streams that have no per-stream abort', () => {
    const findings = check(StreamSettleRule, hook, [
      'export async function runAll(urls: string[], completedIndexes: number[]) {',
      '  await Promise.all(urls.map((u) => fetch(u)));',
      '  return completedIndexes;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Stream: Parallel streams missing per-stream abort' });
  });

  test('does not flag parallel streams that each carry an AbortController', () => {
    const findings = check(StreamSettleRule, hook, [
      'export async function runAll(urls: string[], completedIndexes: number[]) {',
      '  const controllers = urls.map(() => new AbortController());',
      '  await Promise.all(urls.map((u, i) => fetch(u, { signal: controllers[i].signal })));',
      '  return completedIndexes;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not run outside the SSE stream hook', () => {
    const findings = check(StreamSettleRule, 'web/hooks/useOther.ts', [
      'export async function runAll(urls: string[], completedIndexes: number[]) {',
      '  await Promise.all(urls.map((u) => fetch(u)));',
      '  return completedIndexes;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('ProxyPromotionRule', () => {
  test('flags a wrangler config that documents the residential proxy without a secret-put step', () => {
    const findings = check(ProxyPromotionRule, 'worker/wrangler.toml', [
      'const note = "RESIDENTIAL_PROXY_URL is read from [vars] in production";',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Config: Proxy credential documented but not deployed as secret' });
  });

  test('does not flag a wrangler config that includes the secret-put instruction', () => {
    const findings = check(ProxyPromotionRule, 'worker/wrangler.toml', [
      'const note = "RESIDENTIAL_PROXY_URL: run wrangler secret put RESIDENTIAL_PROXY_URL";',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('flags a TypeScript reference that reads the proxy URL without the env binding', () => {
    const findings = check(ProxyPromotionRule, 'worker/src/transcript.ts', [
      'export function proxyFor(config: { url: string }) {',
      '  const proxy = RESIDENTIAL_PROXY_URL;',
      '  return proxy ?? config.url;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('Config: Proxy URL accessed directly without env secret');
  });

  test('does not flag a TypeScript read through the env binding', () => {
    const findings = check(ProxyPromotionRule, 'worker/src/transcript.ts', [
      'export function proxyFor(env: { RESIDENTIAL_PROXY_URL?: string }) {',
      '  return env.RESIDENTIAL_PROXY_URL;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag the type declaration of the proxy field', () => {
    const findings = check(ProxyPromotionRule, 'worker/src/env.ts', [
      'export interface Env { RESIDENTIAL_PROXY_URL?: string }',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});
