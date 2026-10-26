import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { Finding, IRule } from "../engine";

export const PersistResilienceRule: IRule = {
  name: "persist-resilience-audit",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    // A test file exercising the persist route/service directly (mocked
    // request/response, no real network retry loop) is not client-calling
    // code and was never meant to be audited by this rule (same exemption
    // shape as security.ts's isTestFile guard).
    if (/\.(test|spec)\.[jt]sx?$/.test(filePath) || filePath.includes('__tests__/')) return findings;
    const text = source.getText();

    if (text.includes('/api/analyses/persist') || text.includes('persistAnalysis')) {
      const hasErrorState = text.includes('setStreamError') || text.includes('settleAnalysis');
      const hasRetry = text.includes('maxRetries') || text.includes('retry');
      if (!hasErrorState && !hasRetry) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "Persist: No error state or retry on failure",
          why: "Persist endpoint call without error state propagation or retry logic.",
          fix: "Add exponential backoff retry (2 attempts) and set error state if all attempts fail."
        });
      }
    }
    return findings;
  }
};

export const PersistAbortScopeRule: IRule = {
  name: "persist-abort-scope",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (text.includes('persist') && text.includes('fetch') && text.includes('signal')) {
      const hasClientSignal = text.includes('req.raw.signal') || text.includes('c.req.raw.signal');
      if (hasClientSignal) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "Persist: Client signal aborts server-side persist",
          why: "Client disconnect signal chained to persist fetch. When user navigates away, persist is killed. Data lost.",
          fix: "Use only a server-side AbortController for persist (10s timeout). Remove client signal from persist fetch."
        });
      }
    }
    return findings;
  }
};

export const RetryFlagInterferenceRule: IRule = {
  name: "retry-flag-interference",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (text.includes('maxRetries') || text.includes('atomic-persist')) {
      // RCA (2026-07-30): a bounded `for (let attempt = 0; attempt < maxRetries; ...)`
      // loop counter matched the old any-initializer regex just as readily as the
      // boolean early-return flag (persistAttempted/hasAttempted) this rule actually
      // targets -- false-positived on web/lib/redis.ts's executeRedisScript, whose
      // `attempt` is a plain retry-count index, not a flag gating an early return.
      // Require a boolean-literal initializer so only the real "flag" shape matches.
      const flagPatterns = text.match(/let\s+\w*(attempt|persisted|done)\w*\s*=\s*(true|false)\b/g) || [];
      if (flagPatterns.length > 0) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "Retry: Flag may interfere with atomic-persist retry loop",
          why: "Attempt-tracking flag (persistAttempted, hasAttempted) may block retries after first failure. Atomic-persist manages its own retry state.",
          fix: "Let atomic-persist manage retry logic. Remove attempt-tracking flags that return early from retry callbacks."
        });
      }
    }
    return findings;
  }
};

export const QuorumTimeoutCompletionRule: IRule = {
  name: "quorum-timeout-completion-audit",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (filePath.includes('persist') || text.includes('quorum')) {
      const hasTimeout = text.includes('setTimeout') || text.includes('timeout');
      const hasQuorum = text.includes('quorum') || text.includes('completedIndexes');
      const hasIncompleteMark = text.includes("'completed'") || text.includes('"completed"');

      if (hasTimeout && hasQuorum && hasIncompleteMark) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "Persist: Quorum timeout marks incomplete chunks as completed",
          why: "Timeout fires but doesn't verify all chunks arrived. Marks partial data as 'completed', causing AnalysisHistory to show stale/incomplete analyses as done.",
          fix: "On timeout, verify which chunks actually persisted. If any missing, mark status as 'partial' or 'error', not 'completed'. Log missing chunk indexes."
        });
      }
    }
    return findings;
  }
};

export const StaleStateResetRule: IRule = {
  name: "stale-state-reset-audit",
  check: (source: SourceFile) => {
    const findings: Finding[] = [];
    const filePath = source.getFilePath().replace(/\\/g, "/");
    const text = source.getText();

    if (text.includes('clearAnalysis') || text.includes('resetState')) {
      const setsMetadataNull = text.includes('videoMetadata: null') || text.includes('videoMetadata:null') || text.includes('setVideoMetadata(null)');
      const hasEagerFetch = text.includes('useEagerVideoMetadata') || text.includes('eager') || text.includes('fetchMetadata');

      if (setsMetadataNull && hasEagerFetch) {
        findings.push({
          file: filePath,
          severity: "high",
          title: "State: clearAnalysis resets videoMetadata to null, losing eager data",
          why: "clearAnalysis() runs on unmount/new URL but sets videoMetadata to null. Eagerly-fetched metadata is destroyed.",
          fix: "Guard clearAnalysis: if videoMetadata was eagerly fetched (source !== 'sse'), preserve it."
        });
      }
    }
    return findings;
  }
};
