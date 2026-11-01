import { LOCATIONS } from "@/lib/locations";
import { REFERENCE_TARGET_IDS } from "@/lib/targets";
import { MAX_ROWS, readBrowser, readFirstRow, readRuns, readSummaries } from "@/lib/store";
import { PAGES, SOURCES } from "@/lib/pages";

// Public and read-only. Returns per-run aggregates, each endpoint's own samples (timings only), and the
// browser summaries. No target URLs, no tokens.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOUR_MS = 3_600_000;
const HALF_HOUR_MS = 30 * 60_000;
// 30-minute runs: 48 a day, so 7 days is 336 summaries.
const WINDOWS: Record<string, { hours: number; limit: number }> = {
  "24h": { hours: 24, limit: 60 },
  "7d": { hours: 168, limit: 400 },
};

type RawSample = { ttfb: number | null; total: number | null; s: number | null; e: string | null; c?: string | null; ed?: string | null; ag?: number | null };
type RawRun = { ts: number; loc: Record<string, Record<string, RawSample>> };
type SeriesPoint = { ts: number; ttfb: number | null; total: number | null; s: number | null; e: string | null; c: string | null; ed: string | null; ag: number | null };

export async function GET(req: Request): Promise<Response> {
  const key = new URL(req.url).searchParams.get("window") === "7d" ? "7d" : "24h";
  const { hours, limit } = WINDOWS[key];
  try {
    const now = Date.now();
    const from = now - hours * HOUR_MS;
    // Only the current locations leave the server. Older stored locations are never returned.
    const keep = new Set(LOCATIONS.map((l) => l.id));
    const runs = (await readSummaries(limit))
      .filter((r) => r.ts >= from)
      .map((r) => ({ ...r, loc: Object.fromEntries(Object.entries(r.loc ?? {}).filter(([id]) => keep.has(id))) }))
      .sort((a, b) => a.ts - b.ts);
    // Per-endpoint series come from the raw rows, so the whole stored history is available, not only the blended medians.
    const series: Record<string, SeriesPoint[]> = {};
    for (const run of (await readRuns(MAX_ROWS)) as RawRun[]) {
      if (run.ts < from || run.ts > now) continue;
      for (const [locId, targets] of Object.entries(run.loc ?? {})) {
        if (!keep.has(locId)) continue;
        for (const [tid, sample] of Object.entries(targets)) {
          (series[tid] ??= []).push({
            ts: run.ts,
            ttfb: sample.ttfb ?? null,
            total: sample.total ?? null,
            s: sample.s ?? null,
            e: sample.e ?? null,
            c: sample.c ?? null,
            ed: sample.ed ?? null,
            ag: sample.ag ?? null,
          });
        }
      }
    }
    for (const points of Object.values(series)) points.sort((a, b) => a.ts - b.ts);
    const firstRaw = await readFirstRow();
    const browser = (await readBrowser(1000)).filter((b) => (b as { runAt: number }).runAt >= from).sort((a, b) => (a as { runAt: number }).runAt - (b as { runAt: number }).runAt);
    return Response.json(
      {
        generatedAt: now,
        window: key,
        windowHours: hours,
        lastRunTs: runs.length ? runs[runs.length - 1].ts : null,
        firstRunTs: firstRaw ? firstRaw.ts : null,
        nextRunAt: Math.ceil((now + 1) / HALF_HOUR_MS) * HALF_HOUR_MS,
        targetCount: REFERENCE_TARGET_IDS.length,
        targetIds: REFERENCE_TARGET_IDS,
        locations: LOCATIONS.map((l) => ({ id: l.id, label: l.label })),
        runs,
        series,
        pages: PAGES.map((p) => ({ id: p.id, label: p.label })),
        sources: SOURCES,
        browser,
      },
      { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=60" } },
    );
  } catch {
    return Response.json({ error: "storage_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
