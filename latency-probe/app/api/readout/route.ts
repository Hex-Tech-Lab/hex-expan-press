import { timingSafeEqual } from "node:crypto";
import { readRuns, MAX_ROWS } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Sample = { s: number | null; r: number; ttfb: number | null; total: number | null; e: string | null };
type Run = { ts: number; loc: Record<string, Record<string, Sample>> };

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: pct(sorted, 0.5), p90: pct(sorted, 0.9), max: sorted[sorted.length - 1] };
}
function authorized(req: Request): boolean {
  const expected = process.env.READOUT_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  if (!expected || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const hours = Math.min(72, Math.max(1, Number(url.searchParams.get("hours") ?? "24")));
  const now = Date.now();
  const from = now - hours * 3_600_000;
  const runs = (await readRuns(MAX_ROWS)) as Run[];
  const inWindow = runs.filter((r) => r.ts >= from && r.ts <= now);

  const locations: Record<string, Record<string, unknown>> = {};
  for (const run of inWindow) {
    for (const [locId, targets] of Object.entries(run.loc ?? {})) {
      locations[locId] ??= {};
      for (const [tid, s] of Object.entries(targets)) {
        const cell = (locations[locId][tid] ??= { n: 0, errors: 0, status: {} as Record<string, number>, ttfb: [] as number[], total: [] as number[] }) as {
          n: number; errors: number; status: Record<string, number>; ttfb: number[]; total: number[];
        };
        cell.n += 1;
        if (s.e !== null) cell.errors += 1;
        const k = s.s === null ? "none" : String(s.s);
        cell.status[k] = (cell.status[k] ?? 0) + 1;
        if (s.e === null && s.ttfb !== null) cell.ttfb.push(s.ttfb);
        if (s.e === null && s.total !== null) cell.total.push(s.total);
      }
    }
  }
  const shaped: Record<string, Record<string, unknown>> = {};
  for (const [locId, targets] of Object.entries(locations)) {
    shaped[locId] = {};
    for (const [tid, c] of Object.entries(targets) as [string, { n: number; errors: number; status: Record<string, number>; ttfb: number[]; total: number[] }][]) {
      shaped[locId][tid] = { n: c.n, errors: c.errors, status: c.status, ttfb: stats(c.ttfb), total: stats(c.total) };
    }
  }
  return Response.json({
    windowHours: hours,
    runs: inWindow.length,
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    locations: shaped,
  });
}
