// Fixture tests for scripts/ops/usage_watch.ts. No network, no .env: the CLI runner and fetch are injected fakes.
import { describe, expect, it } from "vitest";
import {
  collect,
  countWithin,
  exitCodeFor,
  fetchSupabase,
  fetchUpstash,
  fetchVercel,
  formatValue,
  parseFirstRow,
  parseInfoField,
  parseJsonFromCli,
  parseNumber,
  parseVercelPage,
  projectRefFromUrl,
  renderTable,
  toRow,
  type CliRunner,
  type Row,
} from "../usage_watch.ts";
import { DEFAULT_GLOBAL, type UsageWatchSettings } from "../../../payments/src/settings_registry.ts";

const S: UsageWatchSettings = { ...DEFAULT_GLOBAL.usage_watch };
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const HOUR = 3_600_000;
const SUPA_REF = "abcdefghijklmnopqrst";
const ENV_OK = {
  SUPABASE_URL: `https://${SUPA_REF}.supabase.co`,
  SUPABASE_ACCESS_TOKEN: "fixture-pat",
  UPSTASH_REDIS_REST_URL: "https://fixture-db.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "fixture-rest",
  UPSTASH_EMAIL: "ops@example.test",
  UPSTASH_API_KEY: "fixture-mgmt",
  UPSTASH_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("toRow and exitCodeFor", () => {
  it("marks OK below the warn ratio and WARN at or above it", () => {
    expect(toRow({ provider: "Vercel", name: "x", used: 79, limit: 100, unit: "count", source: "s" }, 0.8).status).toBe("OK");
    expect(toRow({ provider: "Vercel", name: "x", used: 80, limit: 100, unit: "count", source: "s" }, 0.8).status).toBe("WARN");
  });

  it("reports UNKNOWN for null or non-finite values, never zero", () => {
    const r = toRow({ provider: "Supabase", name: "x", used: null, limit: 100, unit: "bytes", source: "s" }, 0.8);
    expect(r.status).toBe("UNKNOWN");
    expect(r.ratio).toBeNull();
    expect(toRow({ provider: "Supabase", name: "x", used: Number.NaN, limit: 100, unit: "bytes", source: "s" }, 0.8).status).toBe("UNKNOWN");
  });

  it("exits 0 when all readable metrics are OK, 1 on WARN, 2 on a source error", () => {
    const ok: Row = toRow({ provider: "Upstash", name: "x", used: 1, limit: 100, unit: "count", source: "s" }, 0.8);
    const unknown: Row = toRow({ provider: "Supabase", name: "y", used: null, limit: 100, unit: "bytes", source: "s" }, 0.8);
    const warn: Row = toRow({ provider: "Upstash", name: "z", used: 90, limit: 100, unit: "count", source: "s" }, 0.8);
    const err: Row = { ...toRow({ provider: "Vercel", name: "e", used: null, limit: 1, unit: "count", source: "" }, 0.8), error: "boom" };
    expect(exitCodeFor([ok, unknown])).toBe(0);
    expect(exitCodeFor([ok, warn])).toBe(1);
    expect(exitCodeFor([ok, err])).toBe(2);
    expect(exitCodeFor([warn, err])).toBe(1);
  });
});

describe("parsers", () => {
  it("parses JSON after the CLI plugin hint line", () => {
    const out = '<claude-code-hint v="1" type="plugin" value="vercel@x" />\n{"deployments":[],"pagination":{"next":null}}\n';
    expect(parseJsonFromCli(out)).toEqual({ deployments: [], pagination: { next: null } });
    expect(() => parseJsonFromCli("no json here")).toThrow("no JSON object");
  });

  it("reads Vercel deployment timestamps and the pagination cursor", () => {
    const page = parseVercelPage({
      deployments: [{ created: NOW - 1000 }, { created: "bad" }, { created: NOW - 2 * HOUR }],
      pagination: { next: NOW - 2 * HOUR },
    });
    expect(page.created).toEqual([NOW - 1000, NOW - 2 * HOUR]);
    expect(page.next).toBe(NOW - 2 * HOUR);
    expect(parseVercelPage({})).toEqual({ created: [], next: null });
  });

  it("counts deployments inside a rolling window", () => {
    const created = [NOW - 10_000, NOW - 2 * HOUR, NOW - 30 * HOUR];
    expect(countWithin(created, NOW, HOUR)).toBe(1);
    expect(countWithin(created, NOW, 24 * HOUR)).toBe(2);
  });

  it("derives the Supabase ref only from a canonical project URL", () => {
    expect(projectRefFromUrl(`https://${SUPA_REF}.supabase.co`)).toBe(SUPA_REF);
    expect(projectRefFromUrl("https://example.com")).toBeNull();
    expect(projectRefFromUrl("https://short.supabase.co")).toBeNull();
    expect(projectRefFromUrl(undefined)).toBeNull();
  });

  it("reads the first row of a read-only query in either response shape", () => {
    expect(parseFirstRow([{ db_bytes: 1 }])).toEqual({ db_bytes: 1 });
    expect(parseFirstRow({ result: [{ db_bytes: 2 }] })).toEqual({ db_bytes: 2 });
    expect(parseFirstRow({})).toEqual({});
  });

  it("reads used_memory from a CRLF INFO block", () => {
    const info = "# Memory\r\nused_memory:204800\r\nused_memory_human:200K\r\n";
    expect(parseInfoField(info, "used_memory")).toBe(204800);
    expect(parseInfoField(info, "missing")).toBeNull();
  });

  it("parses numbers only when finite", () => {
    expect(parseNumber("42")).toBe(42);
    expect(parseNumber(7)).toBe(7);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("x")).toBeNull();
    expect(parseNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("formats values by unit", () => {
    expect(formatValue(null, "count")).toBe("n/a");
    expect(formatValue(4, "hours")).toBe("4.0 h");
    expect(formatValue(1_500, "count")).toBe("1,500");
    expect(formatValue(2 * 1024 ** 2, "bytes")).toBe("2.0 MB");
    expect(formatValue(3 * 1024 ** 3, "bytes")).toBe("3.00 GB");
    expect(formatValue(512, "bytes")).toBe("512 B");
  });
});

describe("fetchVercel", () => {
  it("pages with until and counts both windows", async () => {
    const calls: string[] = [];
    const run: CliRunner = async (args) => {
      calls.push(args[1]);
      if (calls.length === 1) {
        return `hint\n${JSON.stringify({ deployments: [{ created: NOW - 60_000 }, { created: NOW - 3 * HOUR }], pagination: { next: NOW - 3 * HOUR } })}`;
      }
      return JSON.stringify({ deployments: [{ created: NOW - 20 * HOUR }], pagination: { next: null } });
    };
    const m = await fetchVercel(S, NOW - 24 * HOUR, NOW, run);
    expect(calls[0]).toContain(`teamId=${S.vercel.team_id}`);
    expect(calls[0]).toContain("limit=100");
    expect(calls[1]).toContain(`until=${NOW - 3 * HOUR - 1}`);
    expect(m.find((x) => x.name === "Deployments (rolling 24 h)")?.used).toBe(3);
    expect(m.find((x) => x.name === "Deployments (rolling 1 h)")?.used).toBe(1);
    expect(m.find((x) => x.name === "Fluid Active CPU (month)")?.used).toBeNull();
  });

  it("flags a truncated scan as a lower bound", async () => {
    const run: CliRunner = async () =>
      JSON.stringify({ deployments: [{ created: NOW - 1000 }], pagination: { next: NOW - 5000 } });
    const m = await fetchVercel({ ...S, vercel: { ...S.vercel, max_pages: 1 } }, NOW - 24 * HOUR, NOW, run);
    expect(m[0].source).toContain("lower bound");
  });
});

describe("fetchSupabase", () => {
  it("reads database and storage bytes through the read-only query endpoint", async () => {
    let seenUrl = "";
    const http = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return jsonResponse([{ db_bytes: 13962387, storage_bytes: "2048" }]);
    }) as typeof fetch;
    const m = await fetchSupabase(S, ENV_OK, http);
    expect(seenUrl).toBe(`${S.endpoints.supabase_api}/v1/projects/${SUPA_REF}/database/query/read-only`);
    expect(m.find((x) => x.name === "Database size")?.used).toBe(13962387);
    expect(m.find((x) => x.name === "File storage")?.used).toBe(2048);
    expect(m.find((x) => x.name === "Egress (month)")?.used).toBeNull();
  });

  it("returns UNKNOWN rows without a token and throws on a non-OK response", async () => {
    const none = await fetchSupabase(S, {}, (async () => jsonResponse([])) as typeof fetch);
    expect(none.every((x) => x.used === null)).toBe(true);
    const bad = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    await expect(fetchSupabase(S, ENV_OK, bad)).rejects.toThrow("HTTP 403");
  });
});

describe("fetchUpstash", () => {
  it("reads memory from REST INFO and monthly totals from the Developer API", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (u.startsWith(ENV_OK.UPSTASH_REDIS_REST_URL)) return jsonResponse({ result: "# Memory\r\nused_memory:1048576\r\n" });
      return jsonResponse({ total_monthly_requests: 6, total_monthly_bandwidth: 712 });
    }) as typeof fetch;
    const m = await fetchUpstash(S, ENV_OK, http);
    expect(m.find((x) => x.name === "Memory")?.used).toBe(1048576);
    expect(m.find((x) => x.name === "Commands (month)")?.used).toBe(6);
    expect(m.find((x) => x.name === "Bandwidth (month)")?.used).toBe(712);
    expect(seen[1].url).toContain("/v2/redis/stats/11111111-2222-3333-4444-555555555555?period=1d");
    expect(seen[1].auth?.startsWith("Basic ")).toBe(true);
  });

  it("reports the Developer API metrics as UNKNOWN when its credentials are absent", async () => {
    const env = { ...ENV_OK, UPSTASH_API_KEY: undefined };
    const http = (async () => jsonResponse({ result: "used_memory:10" })) as typeof fetch;
    const m = await fetchUpstash(S, env, http);
    expect(m.find((x) => x.name === "Commands (month)")?.used).toBeNull();
    expect(m.find((x) => x.name === "Memory")?.used).toBe(10);
  });
});

describe("collect and renderTable", () => {
  it("keeps other providers when one fails and exits 2", async () => {
    const rows = await collect(S, ENV_OK, {
      now: NOW,
      run: async () => {
        throw new Error("not logged in");
      },
      http: (async (url: string | URL | Request) =>
        String(url).includes("api.supabase.com")
          ? jsonResponse([{ db_bytes: 1, storage_bytes: 1 }])
          : jsonResponse({ result: "used_memory:1", total_monthly_requests: 1, total_monthly_bandwidth: 1 })) as typeof fetch,
    });
    const vercelErr = rows.find((r) => r.provider === "Vercel");
    expect(vercelErr?.error).toContain("not logged in");
    expect(rows.some((r) => r.provider === "Supabase" && r.used !== null)).toBe(true);
    expect(exitCodeFor(rows)).toBe(2);
  });

  it("renders the table with status and an error row without a fake limit", () => {
    const rows: Row[] = [
      toRow({ provider: "Upstash", name: "Commands (month)", used: 450000, limit: 500000, unit: "count", source: "src" }, 0.8),
      { ...toRow({ provider: "Vercel", name: "Deployments", used: null, limit: 1, unit: "count", source: "" }, 0.8), error: "boom" },
    ];
    const text = renderTable(rows, 0.8);
    expect(text).toContain("WARN");
    expect(text).toContain("90.0%");
    expect(text).toContain("ERROR: boom");
    expect(text).toContain("warn at 80% of limit | WARN 1 | UNKNOWN 1");
  });
});
