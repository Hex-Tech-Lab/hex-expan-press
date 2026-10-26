/**
 * Reliability rules Q2 (2026-09-24 wave) — R6, R7, R9, R11.
 *
 * Each rule has a positive-fire test using the real historical snippet
 * (quoted from the pre-fix PR head commit) and a negative-control test with
 * the fixed/safe shape. Sources:
 * - R6/R7: cb5d1aa2 web/lib/admin-logs/fetchers.ts (PR #321)
 * - R9:    92cb6a75 worker/src/routes/analysis.ts (PR #320)
 * - R11:   8c159c92 web/app/api/analyses/[id]/relations/route.ts (PR #322)
 */

import { test, describe, expect } from 'vitest';
import { Project } from 'ts-morph';
import {
  SilentDefaultOnExternalResponseRule,
  ServerFetchWithoutTimeoutRule,
  ErrorPathAsymmetryRule,
  SuccessGuardedPersistenceRule,
} from '../rules/reliability-lessons-20260924';
import type { Rule } from '../rules/reliability-lessons-20260924';
import type { SourceFile } from 'ts-morph';

function createTestSource(code: string, path = 'test.ts'): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(path, code);
}

function check(rule: Rule, code: string, path = 'test.ts') {
  return rule.check({
    filePath: path,
    ast: createTestSource(code, path),
    allFiles: undefined,
  });
}

describe('R6: SilentDefaultOnExternalResponseRule', () => {
  test('fires on the real PR #321 snippet (obsJson?.result?.events?.events || [])', () => {
    // Verbatim shape from cb5d1aa2 web/lib/admin-logs/fetchers.ts
    const code = `
      import * as Sentry from '@sentry/nextjs';
      async function fetchCloudflareObservability(token: string, accountId: string, startTimeMs: number, endTimeMs: number) {
        const obsRes = await fetch('https://api.cloudflare.com/client/v4/accounts/x/workers/observability/telemetry/query', {
          method: 'POST',
          headers: { Authorization: \`Bearer \${token}\` },
        });
        const obsJson = await obsRes.json();
        observabilityEvents = obsJson?.result?.events?.events || [];
        return observabilityEvents;
      }
      let observabilityEvents: unknown[] = [];
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain("'obsJson'");
  }, 20000);

  test('fires on the other real snippet (workersInvocationsAdaptive || [])', () => {
    const code = `
      async function fetchGraphQL(token: string) {
        const res = await fetchWithTimeout('https://api.cloudflare.com/client/v4/graphql');
        const json = await res.json();
        const rawInvocations = json?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
        return rawInvocations;
      }
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain("'json'");
  }, 20000);

  test('negative control: explicit-shape check before defaulting does not fire', () => {
    const code = `
      async function fetchObservability(token: string) {
        const obsRes = await fetch('https://api.cloudflare.com/client/v4/observability', { method: 'POST' });
        const obsJson = await obsRes.json();
        const events = obsJson?.result?.events?.events;
        if (!Array.isArray(events)) {
          throw new Error(\`Unexpected Workers Observability shape: \${JSON.stringify(obsJson).slice(0, 200)}\`);
        }
        return events;
      }
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: internal optional data with ?? [] does not fire', () => {
    const code = `
      function render(store: { items?: string[] }) {
        return store?.items ?? [];
      }
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/components/Foo.tsx');
    expect(findings.length).toBe(0);
  });

  test('negative control: `|| []` with a non-optional chain does not fire', () => {
    const code = `
      async function rows(supabase: any) {
        const data = await res.json();
        return (data.rows || []).forEach((r: unknown) => r);
      }
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });

  test('fires through a simple alias chain (const payload = json)', () => {
    const code = `
      async function load() {
        const res = await fetch('https://api.example.com/shape');
        const json = await res.json();
        const payload = json;
        return payload?.deep?.items || [];
      }
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain("'payload'");
  });

  test('negative control: shadowed unrelated same-name variable does not fire', () => {
    const code = `
      const json = await (await fetch('https://api.example.com/x')).json();
      function renderUnrelated(json: { note?: string }) {
        return json?.note || [];
      }
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: comments and string literals mentioning fetch/.json() do not create roots', () => {
    const code = `
      // TODO: call .json() and fetch( the real endpoint later.
      function makeHint() {
        const hint = 'use .json() and fetch( here';
        return hint?.trimFallback || [];
      }
    `;
    const findings = check(SilentDefaultOnExternalResponseRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });
});

describe('R7: ServerFetchWithoutTimeoutRule', () => {
  test('fires on the real PR #321 second Cloudflare call (no signal)', () => {
    // Verbatim shape from cb5d1aa2 web/lib/admin-logs/fetchers.ts
    const code = `
      async function fetchObservability(token: string, accountId: string) {
        const obsRes = await fetch(\`https://api.cloudflare.com/client/v4/accounts/\${accountId}/workers/observability/telemetry/query\`, {
          method: 'POST',
          headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ queryId: 'x', view: 'events' }),
        });
        return obsRes;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain('without timeout');
  });

  test('negative control: fetch with AbortController signal does not fire', () => {
    const code = `
      async function qstash(token: string, url: string) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { headers: { Authorization: \`Bearer \${token}\` }, signal: controller.signal });
        clearTimeout(timeoutId);
        return res;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: fetchWithTimeout wrapper does not fire', () => {
    const code = `
      async function obs(token: string) {
        const res = await fetchWithTimeout('https://api.cloudflare.com/client/v4/observability', {
          method: 'POST',
          headers: { Authorization: \`Bearer \${token}\` },
        });
        return res;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: client-side file (hooks/components) does not fire', () => {
    const code = `
      async function stream() {
        const res = await fetch('/api/analyses/stream', { method: 'POST' });
        return res.body;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/hooks/useSSEStream.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: domain-method wrapper .fetch() with internal timeouts does not fire', () => {
    const code = `
      async function run() {
        const extractor = new TranscriptExtractor('key');
        const result = await extractor.fetch(videoId);
        return result;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'worker/src/routes/transcript.ts');
    expect(findings.length).toBe(0);
  });

  test('fires when signal is undefined (no deadline at all)', () => {
    const code = `
      async function callUpstream(url: string) {
        const res = await fetch(url, { headers: { Authorization: 'Bearer x' }, signal: undefined });
        return res;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain('without timeout');
  });

  test('fires when the controller is never aborted (no setTimeout wired)', () => {
    const code = `
      async function callUpstream(url: string) {
        const controller = new AbortController();
        const res = await fetch(url, { signal: controller.signal });
        return res;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain('without timeout');
  });

  test('negative control: AbortSignal.timeout() is bounded and does not fire', () => {
    const code = `
      async function callUpstream(url: string) {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return res;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: AbortSignal.any([...AbortSignal.timeout(...)]) is bounded and does not fire', () => {
    const code = `
      async function callUpstream(url: string, external: AbortSignal) {
        const res = await fetch(url, { signal: AbortSignal.any([external, AbortSignal.timeout(8000)]) });
        return res;
      }
    `;
    const findings = check(ServerFetchWithoutTimeoutRule, code, 'web/lib/admin-logs/fetchers.ts');
    expect(findings.length).toBe(0);
  });
});

describe('R9: ErrorPathAsymmetryRule', () => {
  test('fires on the real PR #320 shape: Sentry on non-2xx branch, console.warn-only sibling catch', () => {
    // Verbatim shape from 92cb6a75 worker/src/routes/analysis.ts (chapter persist)
    const code = `
      import * as Sentry from '@sentry/cloudflare';
      function chapterPersist() {
        return (async () => {
          try {
            const response = await fetch(appUrl + '/api/videos/' + videoId + '/chapters', { method: 'POST', signal: controller.signal });
            if (!response.ok) {
              const bodySnippet = (await response.text()).slice(0, 200);
              console.error('[analyze-llm-stream] Chapter persist returned non-2xx', { status: response.status });
              Sentry.captureMessage('Chapter persist returned non-2xx', {
                level: 'error',
                tags: { component: 'analyze-llm-stream' },
                extra: { videoId, status: response.status },
              });
            }
          } catch (err) {
            console.warn('[analyze-llm-stream] Chapter persist failed (non-blocking)', {
              videoId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }
    `;
    const findings = check(ErrorPathAsymmetryRule, code, 'worker/src/routes/analysis.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain('console-only');
  });

  test('negative control: sibling catch also captures to Sentry does not fire', () => {
    const code = `
      import * as Sentry from '@sentry/cloudflare';
      function chapterPersist() {
        return (async () => {
          try {
            const response = await fetch('/api/chapters', { method: 'POST' });
            if (!response.ok) {
              console.error('non-2xx', response.status);
              Sentry.captureMessage('Chapter persist returned non-2xx', { level: 'error' });
            }
          } catch (err) {
            console.warn('Chapter persist failed (non-blocking)', err);
            Sentry.captureException(err, { tags: { phase: 'chapter-persist' } });
          }
        })();
      }
    `;
    const findings = check(ErrorPathAsymmetryRule, code, 'worker/src/routes/analysis.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: function with no Sentry anywhere does not fire (no asymmetry)', () => {
    const code = `
      function cleanup() {
        try {
          doCleanup();
        } catch (err) {
          console.warn('cleanup failed', err);
        }
      }
    `;
    const findings = check(ErrorPathAsymmetryRule, code, 'web/lib/adapters/YouTubePlayerAdapter.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: rethrowing catch does not fire', () => {
    const code = `
      import * as Sentry from '@sentry/cloudflare';
      function wrapper() {
        try {
          inner();
        } catch (err) {
          console.warn('retrying', err);
          throw err;
        }
      }
    `;
    const findings = check(ErrorPathAsymmetryRule, code, 'worker/src/services/LLMCascade.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: Sentry capture elsewhere in the function (different try) does not fire', () => {
    // Deliberate best-effort convention: console-only catch here, terminal
    // Sentry capture after the retry loop / in an earlier independent try.
    const code = `
      import * as Sentry from '@sentry/cloudflare';
      async function persist() {
        try {
          firstAttempt();
        } catch (setupErr) {
          console.warn('[persist] setup failed (non-blocking)', setupErr);
        }
        try {
          await doPersist();
        } catch (e) {
          Sentry.captureMessage('persist exhausted all retries', { level: 'error' });
        }
      }
    `;
    const findings = check(ErrorPathAsymmetryRule, code, 'worker/src/services/PersistService.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: Sentry capture inside a nested function in the try block is not sibling asymmetry', () => {
    // A capture inside a .map(() => ...) callback runs in a different
    // execution branch than the try's own failure path — must NOT count.
    const code = `
      import * as Sentry from '@sentry/cloudflare';
      async function batch(items: string[]) {
        try {
          items.map((it) => {
            if (!it) Sentry.captureMessage('empty item', { level: 'warning' });
            return process(it);
          });
        } catch (err) {
          console.warn('[batch] item failed (non-blocking)', err);
        }
      }
    `;
    const findings = check(ErrorPathAsymmetryRule, code, 'worker/src/routes/analysis.ts');
    expect(findings.length).toBe(0);
  });

  test('a comment mentioning Sentry.capture does not mask the asymmetry (AST check, not textual)', () => {
    const code = `
      import * as Sentry from '@sentry/cloudflare';
      async function persist() {
        try {
          const response = await doWork();
          if (!response.ok) {
            console.error('non-2xx', response.status);
            Sentry.captureMessage('persist returned non-2xx', { level: 'error' });
          }
        } catch (err) {
          // Not capturing here: Sentry.captureException would double-report
          // since the non-2xx branch above already captures.
          console.warn('[persist] failed (non-blocking)', err);
        }
      }
    `;
    const findings = check(ErrorPathAsymmetryRule, code, 'worker/src/routes/analysis.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain('console-only');
  });
});

describe('R11: SuccessGuardedPersistenceRule', () => {
  test('fires on the real PR #322 shape: update write-through gated on insights.length > 0', () => {
    // Verbatim shape from 8c159c92 web/app/api/analyses/[id]/relations/route.ts:178
    const code = `
      export async function route(id: string, insights: unknown[], payload: unknown, supabase: any, cacheKey: string) {
        const result = { insights, generatedAt: new Date().toISOString() };
        if (insights.length > 0) {
          await Promise.allSettled([
            setRedisValue(cacheKey, JSON.stringify(result), 604800).catch((cacheErr: unknown) => {
              console.warn('[relations/route] Failed to cache', String(cacheErr));
            }),
            supabase
              .from('analyses')
              .update({ analysis_payload: { ...(payload || {}), stance_relations: result } })
              .eq('id', id),
          ]);
        }
        return result;
      }
    `;
    const findings = check(SuccessGuardedPersistenceRule, code, 'web/app/api/analyses/[id]/relations/route.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain("'insights.length > 0'");
  });

  test('negative control: unconditional persistence does not fire', () => {
    const code = `
      export async function route(id: string, insights: unknown[], payload: unknown, supabase: any, cacheKey: string) {
        const result = { insights };
        await Promise.allSettled([
          setRedisValue(cacheKey, JSON.stringify(result), 604800),
          supabase.from('analyses').update({ analysis_payload: { ...(payload || {}), stance_relations: result } }).eq('id', id),
        ]);
        return result;
      }
    `;
    const findings = check(SuccessGuardedPersistenceRule, code, 'web/app/api/analyses/[id]/relations/route.ts');
    expect(findings.length).toBe(0);
  });

  test('negative control: empty-batch insert guard does not fire (legitimate pattern)', () => {
    const code = `
      export async function save(rows: Record<string, unknown>[], supabase: any) {
        if (rows.length > 0) {
          await supabase.from('markers').insert(rows);
        }
      }
    `;
    const findings = check(SuccessGuardedPersistenceRule, code, 'web/app/api/persist/route.ts');
    expect(findings.length).toBe(0);
  });

  test('fires on the truthiness variant: if (x.length) gating an update write-through', () => {
    const code = `
      export async function route(id: string, insights: unknown[], payload: unknown, supabase: any) {
        const result = { insights };
        if (insights.length) {
          await supabase.from('analyses').update({ analysis_payload: { ...(payload || {}), stance_relations: result } }).eq('id', id);
        }
        return result;
      }
    `;
    const findings = check(SuccessGuardedPersistenceRule, code, 'web/app/api/analyses/[id]/relations/route.ts');
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain("'insights.length'");
  });
});
