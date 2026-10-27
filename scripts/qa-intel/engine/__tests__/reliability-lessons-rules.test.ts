/**
 * Reliability rules (rules/reliability-lessons-20260924.ts), CRITICAL classification: silent empty defaults, fetches
 * without deadlines, asymmetric error telemetry and skipped persistence are all silent-failure shapes.
 *
 * reliability-q2-rules.test.ts covers the canonical positive and negative per rule. This file pins the remaining
 * branches: optional-call bases, shadowing, the signal forms, the nested-callback telemetry exemption and the
 * truthiness predicate. Each test asserts a concrete finding or a concrete non-finding.
 */

import { describe, test, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { Rule, RuleContext } from '../domain/Rule';
import {
  SilentDefaultOnExternalResponseRule,
  ServerFetchWithoutTimeoutRule,
  ErrorPathAsymmetryRule,
  SuccessGuardedPersistenceRule,
} from '../rules/reliability-lessons-20260924';

// These rules resolve symbols and declarations only, never lib types, so the lib files are skipped. Loading them for
// the first symbol lookup took over the 5s test timeout under suite load.
const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });

function check(rule: Rule, filePath: string, code: string) {
  const sf = project.createSourceFile(filePath, code, { overwrite: true });
  const ctx: RuleContext = { filePath, ast: sf, allFiles: [filePath] };
  return rule.check(ctx);
}

describe('SilentDefaultOnExternalResponseRule (branch coverage)', () => {
  test('flags an optional-call base that resolves to a fetched JSON root', () => {
    const findings = check(SilentDefaultOnExternalResponseRule, 'web/lib/feed.ts', [
      'export async function loadRows(url: string) {',
      '  const body = await fetchWithTimeout(url);',
      '  const rows = body.getRows?.() ?? [];',
      '  return rows;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toContain("('body')");
  });

  test('flags an empty default on a globalThis.fetch response', () => {
    const findings = check(SilentDefaultOnExternalResponseRule, 'web/lib/feed.ts', [
      'export async function loadItems(url: string) {',
      '  const res = await globalThis.fetch(url);',
      '  const items = res?.body?.items || [];',
      '  return items;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('does not flag a same-named parameter that shadows the fetched root', () => {
    const findings = check(SilentDefaultOnExternalResponseRule, 'web/lib/feed.ts', [
      'export async function parse(url: string) {',
      '  const json = await (await fetch(url)).json();',
      '  return json;',
      '}',
      'export function pick(json?: { items?: string[] }) {',
      '  return json?.items || [];',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag an empty default on purely internal optional data', () => {
    const findings = check(SilentDefaultOnExternalResponseRule, 'web/lib/store.ts', [
      'export function visible(store: { items?: string[] }) {',
      '  return store?.items ?? [];',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('ServerFetchWithoutTimeoutRule (signal forms)', () => {
  const route = 'web/app/api/analyses/route.ts';

  test('flags a server fetch with no signal option at all', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string) {',
      '  const res = await fetch(upstreamUrl);',
      '  return res;',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'medium', title: 'Reliability: server-side fetch without timeout/AbortSignal' });
  });

  test('does not flag a fetch bounded by AbortSignal.timeout', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string) {',
      '  return fetch(upstreamUrl, { signal: AbortSignal.timeout(5000) });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a fetch whose controller is aborted by a setTimeout in the same scope', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string) {',
      '  const controller = new AbortController();',
      '  setTimeout(() => controller.abort(), 5000);',
      '  return fetch(upstreamUrl, { signal: controller.signal });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag AbortSignal.any when one element is a bounded timeout', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string, req: Request) {',
      '  return fetch(upstreamUrl, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(3000)]) });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('flags AbortSignal.any over a non-literal list, because the list is not provably bounded', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string, signals: AbortSignal[]) {',
      '  return fetch(upstreamUrl, { signal: AbortSignal.any(signals) });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('flags a bare signal identifier, which cannot be traced to a deadline', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string, abortSignal: AbortSignal) {',
      '  return fetch(upstreamUrl, { signal: abortSignal });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('flags a shorthand signal property, which the rule treats as untraceable', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string, signal: AbortSignal) {',
      '  return fetch(upstreamUrl, { signal, method: "GET" });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('flags a fetch whose options come from a spread, which hides the signal', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, route, [
      'export async function GET(upstreamUrl: string, opts: RequestInit) {',
      '  return fetch(upstreamUrl, { ...opts });',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('does not apply to client components, which may stream long responses', () => {
    const findings = check(ServerFetchWithoutTimeoutRule, 'web/components/Feed.tsx', [
      'export function Feed(url: string) { return fetch(url); }',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('ErrorPathAsymmetryRule', () => {
  const file = 'web/lib/auth-check.ts';

  test('flags a catch that only console-warns beside a try that captures to Sentry', () => {
    const findings = check(ErrorPathAsymmetryRule, file, [
      'export async function loadAuth(url: string) {',
      '  try {',
      '    const res = await fetch(url);',
      '    if (!res.ok) { Sentry.captureMessage("auth non-2xx", { level: "error" }); }',
      '  } catch (err) {',
      '    console.warn("auth fetch failed", err);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.why).toContain("('err')");
  });

  test('does not flag a console-only catch that rethrows the error', () => {
    const findings = check(ErrorPathAsymmetryRule, file, [
      'export async function loadAuth(url: string) {',
      '  try {',
      '    if (!url) Sentry.captureMessage("missing url");',
      '  } catch (err) {',
      '    console.error("failed", err);',
      '    throw err;',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a catch that also captures to Sentry', () => {
    const findings = check(ErrorPathAsymmetryRule, file, [
      'export async function loadAuth(url: string) {',
      '  try {',
      '    if (!url) Sentry.captureMessage("missing url");',
      '  } catch (err) {',
      '    Sentry.captureException(err);',
      '    console.warn("failed", err);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a Sentry capture that lives inside a nested callback of the try block', () => {
    const findings = check(ErrorPathAsymmetryRule, file, [
      'export async function loadAll(urls: string[]) {',
      '  try {',
      '    urls.map((u) => { Sentry.captureMessage(u); });',
      '  } catch (err) {',
      '    console.warn("failed", err);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a console-only catch with no Sentry capture in its try', () => {
    const findings = check(ErrorPathAsymmetryRule, file, [
      'export function best(effort: () => void) {',
      '  try {',
      '    effort();',
      '  } catch (err) {',
      '    console.warn("best effort failed", err);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});

describe('SuccessGuardedPersistenceRule (predicate and sink forms)', () => {
  const file = 'web/app/api/analyses/[id]/relations/route.ts';

  test('flags an update gated on a length greater than zero', () => {
    const findings = check(SuccessGuardedPersistenceRule, file, [
      'export async function persist(id: string, insights: unknown[], supabase: any) {',
      '  if (insights.length > 0) {',
      '    await supabase.from("analyses").update({ relations: insights }).eq("id", id);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toContain("('insights.length > 0')");
  });

  test('flags a Redis write-through gated on the truthiness of a length', () => {
    const findings = check(SuccessGuardedPersistenceRule, file, [
      'export async function cache(key: string, rows: unknown[]) {',
      '  if (rows.length) {',
      '    setRedisValue(key, rows);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(1);
  });

  test('does not flag an insert skipped on an empty batch, which is a legitimate no-op', () => {
    const findings = check(SuccessGuardedPersistenceRule, file, [
      'export async function save(insights: unknown[], supabase: any) {',
      '  if (insights.length > 0) {',
      '    await supabase.from("analyses").insert(insights);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });

  test('does not flag a length guard around a render, which is not a write-through', () => {
    const findings = check(SuccessGuardedPersistenceRule, file, [
      'export function show(items: unknown[]) {',
      '  if (items.length > 0) {',
      '    render(items);',
      '  }',
      '}',
    ].join('\n'));
    expect(findings).toHaveLength(0);
  });
});
