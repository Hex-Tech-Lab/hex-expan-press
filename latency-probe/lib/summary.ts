import type { TargetSample } from "./measure";

// Per-run, per-location aggregate. Small on purpose: the dashboard reads these, not the raw rows.
export type LocSummary = { n: number; ok: number; err: number; to: number; rt: number; et?: Record<string, number>; ttfb: number | null; total: number | null };
export type RunSummary = { ts: number; loc: Record<string, LocSummary> };
export type RawRow = { ts: number; loc: Record<string, Record<string, TargetSample>> };

// These targets answer 401 by design (no credential is sent), so 401 counts as success for them.
const EXPECT_401 = new Set(["supabase-rest", "upstash-rest-prod"]);

export function isSuccess(targetId: string, s: TargetSample): boolean {
  if (s.e !== null || s.s === null) return false;
  return s.s < 400 || (s.s === 401 && EXPECT_401.has(targetId));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.max(0, Math.ceil(0.5 * a.length) - 1))] * 10) / 10;
}

// Count of each error tag in a location (for example proxy_522, timeout). Empty when no errors.
function errorTags(samples: [string, TargetSample][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [, s] of samples) if (s.e !== null) out[s.e] = (out[s.e] ?? 0) + 1;
  return out;
}

export function summarize(row: RawRow): RunSummary {
  const loc: Record<string, LocSummary> = {};
  for (const [locId, targets] of Object.entries(row.loc ?? {})) {
    const samples = Object.entries(targets);
    const ok = samples.filter(([tid, s]) => isSuccess(tid, s));
    loc[locId] = {
      n: samples.length,
      ok: ok.length,
      err: samples.filter(([, s]) => s.e !== null).length,
      to: samples.filter(([, s]) => s.e === "timeout").length,
      rt: samples.filter(([, s]) => (s.a ?? 1) === 2).length,
      et: errorTags(samples),
      ttfb: median(ok.map(([, s]) => s.ttfb).filter((v): v is number => v !== null)),
      total: median(ok.map(([, s]) => s.total).filter((v): v is number => v !== null)),
    };
  }
  return { ts: row.ts, loc };
}
