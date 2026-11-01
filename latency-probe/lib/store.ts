import { Redis } from "@upstash/redis";
import { summarize, type RawRow, type RunSummary } from "./summary";

export const RUNS_KEY = "probe:runs";
export const SUMMARY_KEY = "probe:summary";
export const FIRST_KEY = "probe:first";
export const BROWSER_KEY = "probe:browser";
export const BROWSER_MAX = 1000;
export const MAX_ROWS = 1500;

// Reads env at call time. Values are never logged or returned to callers.
export function redis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("redis_env_missing");
  return new Redis({ url, token, automaticDeserialization: false });
}

// One pipeline: raw row, its summary, and the first run kept once (NX).
export async function appendRun(row: RawRow): Promise<void> {
  const summary = summarize(row);
  await redis()
    .pipeline()
    .lpush(RUNS_KEY, JSON.stringify(row))
    .ltrim(RUNS_KEY, 0, MAX_ROWS - 1)
    .lpush(SUMMARY_KEY, JSON.stringify(summary))
    .ltrim(SUMMARY_KEY, 0, MAX_ROWS - 1)
    .set(FIRST_KEY, JSON.stringify(row), { nx: true })
    .exec();
}

export async function readRuns(limit: number): Promise<unknown[]> {
  const raw = await redis().lrange<string>(RUNS_KEY, 0, Math.min(limit, MAX_ROWS) - 1);
  return raw.map((s) => JSON.parse(s as string));
}

// Newest first.
export async function readSummaries(limit: number): Promise<RunSummary[]> {
  const raw = await redis().lrange<string>(SUMMARY_KEY, 0, Math.min(limit, MAX_ROWS) - 1);
  return raw.map((s) => JSON.parse(s as string) as RunSummary);
}

export async function readFirstRow(): Promise<RawRow | null> {
  const raw = await redis().get<string>(FIRST_KEY);
  return raw ? (JSON.parse(raw as string) as RawRow) : null;
}

// Browser summaries from /api/ingest. Newest first.
export async function appendBrowser(row: unknown): Promise<void> {
  await redis().pipeline().lpush(BROWSER_KEY, JSON.stringify(row)).ltrim(BROWSER_KEY, 0, BROWSER_MAX - 1).exec();
}

export async function readBrowser(limit: number): Promise<unknown[]> {
  const raw = await redis().lrange<string>(BROWSER_KEY, 0, Math.min(limit, BROWSER_MAX) - 1);
  return raw.map((s) => JSON.parse(s as string));
}
