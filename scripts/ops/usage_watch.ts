// usage_watch.ts: read-only daily usage check for Vercel (Hobby), Supabase (Free org) and Upstash Redis (pay-as-you-go).
//
// Limits and endpoints come from payments/src/settings_registry.ts (usage_watch). Nothing numeric is hard-coded here
// except unit conversions. A metric that no verified API exposes is printed as UNKNOWN with the reason, never as 0.
//
// Exit codes: 0 = every readable metric is below warn_ratio of its limit (UNKNOWN rows do not fail the run);
//             1 = at least one metric is at or above warn_ratio of its limit (WARN);
//             2 = a readable source failed (request error), so the watch could not decide. WARN wins over 2.
//
// Usage: node --import tsx scripts/ops/usage_watch.ts [--json]
// Secrets are read from the environment only and are never printed.

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { GLOBAL, type UsageWatchSettings } from "../../payments/src/settings_registry.ts";

export type Status = "OK" | "WARN" | "UNKNOWN";
export type Unit = "count" | "bytes" | "hours";

export interface Metric {
  provider: "Vercel" | "Supabase" | "Upstash";
  name: string;
  /** null = not readable through a verified API. Never rendered as zero. */
  used: number | null;
  limit: number;
  unit: Unit;
  /** Where the number came from, or why it is unknown. */
  source: string;
  /** Request failure text (our own message, never a response body or credential). */
  error?: string;
}

export interface Row extends Metric {
  ratio: number | null;
  status: Status;
}

export type Env = Record<string, string | undefined>;
export type CliRunner = (args: string[]) => Promise<string>;
export type HttpFetch = typeof fetch;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const VERCEL_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Pure helpers (no I/O; covered by scripts/ops/__tests__ with fixtures)
// ---------------------------------------------------------------------------

export function toRow(metric: Metric, warnRatio: number): Row {
  if (metric.used === null || !Number.isFinite(metric.used)) return { ...metric, ratio: null, status: "UNKNOWN" };
  const ratio = metric.used / metric.limit;
  return { ...metric, ratio, status: ratio >= warnRatio ? "WARN" : "OK" };
}

export function exitCodeFor(rows: Row[]): 0 | 1 | 2 {
  if (rows.some((r) => r.status === "WARN")) return 1;
  if (rows.some((r) => r.error !== undefined)) return 2;
  return 0;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `vercel api` prints a plugin hint line before the JSON body. Parse from the first brace to the last. */
export function parseJsonFromCli(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in CLI output");
  return JSON.parse(text.slice(start, end + 1));
}

export interface VercelPage {
  created: number[];
  next: number | null;
}

export function parseVercelPage(json: unknown): VercelPage {
  const o = asRecord(json);
  const list = Array.isArray(o.deployments) ? o.deployments : [];
  const created = list
    .map((d) => parseNumber(asRecord(d).created))
    .filter((n): n is number => n !== null);
  const next = parseNumber(asRecord(o.pagination).next);
  return { created, next };
}

export function countWithin(created: number[], nowMs: number, windowMs: number): number {
  return created.filter((t) => t >= nowMs - windowMs && t <= nowMs).length;
}

/** Supabase project ref from https://<ref>.supabase.co (ref is 20 lowercase alphanumerics). */
export function projectRefFromUrl(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url ?? "");
  return m ? m[1] : null;
}

/** Supabase read-only query result: either an array of rows or {result: rows}. */
export function parseFirstRow(json: unknown): Record<string, unknown> {
  if (Array.isArray(json)) return asRecord(json[0]);
  const r = asRecord(json).result;
  if (Array.isArray(r)) return asRecord(r[0]);
  return {};
}

/** Pull one `key:value` field out of a Redis INFO text block. */
export function parseInfoField(info: string, key: string): number | null {
  const re = new RegExp(`^${key}:(\\S+)\\s*$`, "m");
  const m = re.exec(info);
  return m ? parseNumber(m[1]) : null;
}

export function formatValue(value: number | null, unit: Unit): string {
  if (value === null) return "n/a";
  if (unit === "hours") return `${value.toFixed(1)} h`;
  if (unit === "count") return value.toLocaleString("en-US");
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${value.toLocaleString("en-US")} B`;
}

export function renderTable(rows: Row[], warnRatio: number): string {
  const header = ["Provider", "Metric", "Used", "Limit", "Used %", "Status", "Source"];
  const body = rows.map((r) => [
    r.provider,
    r.name,
    r.error ? "-" : formatValue(r.used, r.unit),
    r.error ? "-" : formatValue(r.limit, r.unit),
    r.ratio === null ? "n/a" : `${(r.ratio * 100).toFixed(1)}%`,
    r.status,
    r.error ? `ERROR: ${r.error}` : r.source,
  ]);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  const warnCount = rows.filter((r) => r.status === "WARN").length;
  const unknownCount = rows.filter((r) => r.status === "UNKNOWN").length;
  return [
    line(header),
    rule,
    ...body.map(line),
    "",
    `warn at ${(warnRatio * 100).toFixed(0)}% of limit | WARN ${warnCount} | UNKNOWN ${unknownCount} | ${new Date().toISOString()}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Providers (I/O; the injected runner and fetch keep them testable without a network)
// ---------------------------------------------------------------------------

export async function fetchVercel(settings: UsageWatchSettings, sinceMs: number, nowMs: number, run: CliRunner): Promise<Metric[]> {
  const created: number[] = [];
  let until: number | null = null;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= settings.vercel.max_pages) {
      truncated = true;
      break;
    }
    const q = new URLSearchParams({ teamId: settings.vercel.team_id, since: String(sinceMs), limit: String(VERCEL_PAGE_SIZE) });
    if (until !== null) q.set("until", String(until));
    const parsed = parseVercelPage(parseJsonFromCli(await run(["api", `/v6/deployments?${q.toString()}`, "--method", "GET"])));
    created.push(...parsed.created);
    if (parsed.next === null || parsed.created.length === 0 || parsed.next - 1 <= sinceMs) break;
    until = parsed.next - 1;
  }
  const note = truncated ? " (page cap hit: count is a lower bound)" : "";
  return [
    {
      provider: "Vercel",
      name: "Deployments (rolling 24 h)",
      used: countWithin(created, nowMs, DAY_MS),
      limit: settings.vercel.deployments_per_day,
      unit: "count",
      source: `vercel api /v6/deployments${note}`,
    },
    {
      provider: "Vercel",
      name: "Deployments (rolling 1 h)",
      used: countWithin(created, nowMs, HOUR_MS),
      limit: settings.vercel.deployments_per_hour,
      unit: "count",
      source: `vercel api /v6/deployments${note}`,
    },
    {
      provider: "Vercel",
      name: "Fluid Active CPU (month)",
      used: null,
      limit: settings.vercel.fluid_active_cpu_hours,
      unit: "hours",
      source: "UNKNOWN: Hobby has no usage API (billing/charges 404 'Plan not found'; vercel usage: no billing data). Read the dashboard Usage page.",
    },
  ];
}

export async function fetchSupabase(settings: UsageWatchSettings, env: Env, http: HttpFetch): Promise<Metric[]> {
  const ref = projectRefFromUrl(env.SUPABASE_URL);
  const token = env.SUPABASE_ACCESS_TOKEN;
  const out: Metric[] = [
    {
      provider: "Supabase",
      name: "Egress (month)",
      used: null,
      limit: settings.supabase.egress_bytes,
      unit: "bytes",
      source: "UNKNOWN: no verified Management API egress endpoint. Read the dashboard Usage page.",
    },
  ];
  if (!ref || !token) {
    out.push(
      { provider: "Supabase", name: "Database size", used: null, limit: settings.supabase.db_size_bytes, unit: "bytes", source: "UNKNOWN: SUPABASE_URL or SUPABASE_ACCESS_TOKEN not set" },
      { provider: "Supabase", name: "File storage", used: null, limit: settings.supabase.file_storage_bytes, unit: "bytes", source: "UNKNOWN: SUPABASE_URL or SUPABASE_ACCESS_TOKEN not set" },
    );
    return out;
  }
  const res = await http(`${settings.endpoints.supabase_api}/v1/projects/${ref}/database/query/read-only`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query:
        "select pg_database_size(current_database())::bigint as db_bytes, " +
        "(select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects)::bigint as storage_bytes",
    }),
    signal: AbortSignal.timeout(settings.timeout_ms),
  });
  if (!res.ok) throw new Error(`Supabase read-only query HTTP ${res.status}`);
  const row = parseFirstRow(await res.json());
  const src = "Management API database/query/read-only";
  out.push(
    { provider: "Supabase", name: "Database size", used: parseNumber(row.db_bytes), limit: settings.supabase.db_size_bytes, unit: "bytes", source: src },
    { provider: "Supabase", name: "File storage", used: parseNumber(row.storage_bytes), limit: settings.supabase.file_storage_bytes, unit: "bytes", source: src },
  );
  return out;
}

export async function fetchUpstash(settings: UsageWatchSettings, env: Env, http: HttpFetch): Promise<Metric[]> {
  const out: Metric[] = [];
  const restUrl = env.UPSTASH_REDIS_REST_URL;
  const restToken = env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !restToken) {
    out.push({ provider: "Upstash", name: "Memory", used: null, limit: settings.upstash.memory_bytes, unit: "bytes", source: "UNKNOWN: REST URL or token not set" });
  } else {
    const res = await http(restUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${restToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(["INFO", "memory"]),
      signal: AbortSignal.timeout(settings.timeout_ms),
    });
    if (!res.ok) throw new Error(`Upstash REST INFO HTTP ${res.status}`);
    const info = asRecord(await res.json()).result;
    out.push({
      provider: "Upstash",
      name: "Memory",
      used: typeof info === "string" ? parseInfoField(info, "used_memory") : null,
      limit: settings.upstash.memory_bytes,
      unit: "bytes",
      source: "REST INFO memory (used_memory)",
    });
  }

  // Command and bandwidth counters exist only on the Developer API (Basic auth: account email + API key).
  const email = env.UPSTASH_EMAIL;
  const apiKey = env.UPSTASH_API_KEY;
  const dbId = env.UPSTASH_DATABASE_ID;
  if (!email || !apiKey || !dbId) {
    const why = "UNKNOWN: needs UPSTASH_EMAIL, UPSTASH_API_KEY and UPSTASH_DATABASE_ID (Developer API)";
    out.push(
      { provider: "Upstash", name: "Commands (month)", used: null, limit: settings.upstash.monthly_commands, unit: "count", source: why },
      { provider: "Upstash", name: "Bandwidth (month)", used: null, limit: settings.upstash.monthly_bandwidth_bytes, unit: "bytes", source: why },
    );
    return out;
  }
  const basic = Buffer.from(`${email}:${apiKey}`).toString("base64");
  const res = await http(`${settings.endpoints.upstash_api}/v2/redis/stats/${encodeURIComponent(dbId)}?period=1d`, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(settings.timeout_ms),
  });
  if (!res.ok) throw new Error(`Upstash Developer API stats HTTP ${res.status}`);
  const stats = asRecord(await res.json());
  const src = "Developer API v2/redis/stats (monthly totals)";
  out.push(
    { provider: "Upstash", name: "Commands (month)", used: parseNumber(stats.total_monthly_requests), limit: settings.upstash.monthly_commands, unit: "count", source: src },
    { provider: "Upstash", name: "Bandwidth (month)", used: parseNumber(stats.total_monthly_bandwidth), limit: settings.upstash.monthly_bandwidth_bytes, unit: "bytes", source: src },
  );
  return out;
}

/** Run one provider; a thrown error becomes an UNKNOWN row carrying the error, so one failure never hides the others. */
async function safely(provider: Metric["provider"], label: string, fn: () => Promise<Metric[]>): Promise<Metric[]> {
  try {
    return await fn();
  } catch (err) {
    return [{ provider, name: label, used: null, limit: 1, unit: "count", source: "", error: err instanceof Error ? err.message : String(err) }];
  }
}

export async function collect(settings: UsageWatchSettings, env: Env, deps: { run: CliRunner; http: HttpFetch; now: number }): Promise<Row[]> {
  const metrics = [
    ...(await safely("Vercel", "Vercel check", () => fetchVercel(settings, deps.now - DAY_MS, deps.now, deps.run))),
    ...(await safely("Supabase", "Supabase check", () => fetchSupabase(settings, env, deps.http))),
    ...(await safely("Upstash", "Upstash check", () => fetchUpstash(settings, env, deps.http))),
  ];
  return metrics.map((metric) => toRow(metric, settings.warn_ratio));
}

function vercelCli(bin: string, timeoutMs: number): CliRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(new Error(`vercel CLI failed: ${err.message.split("\n")[0]}`));
        else resolve(stdout);
      });
    });
}

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const settings = GLOBAL.usage_watch;
  const json = process.argv.includes("--json");
  const rows = await collect(settings, process.env, {
    run: vercelCli(settings.endpoints.vercel_cli, settings.timeout_ms),
    http: fetch,
    now: Date.now(),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify({ warn_ratio: settings.warn_ratio, rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderTable(rows, settings.warn_ratio)}\n`);
  }
  process.exitCode = exitCodeFor(rows);
}

const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`usage_watch failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
