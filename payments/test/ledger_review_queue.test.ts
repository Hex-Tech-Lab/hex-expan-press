// Tests for listManualReviewRefunds (audit_log review-queue reader).
// Hermetic: fetchImpl injected, no filesystem writes, no .env loaded.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listManualReviewRefunds } from "../src/ledger.ts";

const URL_BASE = "https://unit.test.supabase.co";

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface Captured {
  url: string;
  headers: Record<string, string>;
}
function captureFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; captured: Captured } {
  const captured: Captured = { url: "", headers: {} };
  const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    captured.url = String(input);
    captured.headers = init?.headers ?? {};
    return jsonRes(body, status);
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function row(id: number, createdAt: string, provider: string, saleId: string) {
  return { id, created_at: createdAt, event: "MANUAL_REVIEW_REQUIRED_REFUND", details: { provider, sale_id: saleId, reason: "amount_mismatch" } };
}

describe("listManualReviewRefunds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("deduplicates by (provider, sale_id) keeping the newest row with occurrences=N", async () => {
    vi.stubEnv("SUPABASE_URL", URL_BASE);
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    // rows arrive newest-first per the enforced order
    const { fetchImpl, captured } = captureFetch([
      row(3, "2026-10-02T03:00:00Z", "polar", "sale-1"),
      row(2, "2026-10-02T02:00:00Z", "polar", "sale-1"),
      row(1, "2026-10-02T01:00:00Z", "polar", "sale-1"),
    ]);
    const out = await listManualReviewRefunds({ fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(3);
    expect(out[0].provider).toBe("polar");
    expect(out[0].sale_id).toBe("sale-1");
    expect(out[0].occurrences).toBe(3);
    expect(out[0].incomplete).toBe(false);
    expect(captured.url).toBe(
      `${URL_BASE}/rest/v1/audit_log?select=id,created_at:at,event,details&event=eq.MANUAL_REVIEW_REQUIRED_REFUND&order=at.desc,id.desc&limit=200`,
    );
    expect(captured.headers["apikey"]).toBe("unit-test-key");
    expect(captured.headers["Authorization"]).toBe("Bearer unit-test-key");
  });

  it("keeps different providers with the same sale_id separate", async () => {
    vi.stubEnv("SUPABASE_URL", URL_BASE);
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    const { fetchImpl } = captureFetch([
      row(2, "2026-10-02T02:00:00Z", "paddle", "sale-1"),
      row(1, "2026-10-02T01:00:00Z", "polar", "sale-1"),
    ]);
    const out = await listManualReviewRefunds({ fetchImpl });
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.provider).sort()).toEqual(["paddle", "polar"]);
    expect(out.every((e) => e.occurrences === 1)).toBe(true);
  });

  it("keeps rows missing sale_id as their own flagged entries (never merged)", async () => {
    vi.stubEnv("SUPABASE_URL", URL_BASE);
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    const { fetchImpl } = captureFetch([
      row(2, "2026-10-02T02:00:00Z", "polar", "sale-1"),
      { id: 1, created_at: "2026-10-02T01:00:00Z", event: "MANUAL_REVIEW_REQUIRED_REFUND", details: { provider: "polar" } },
    ]);
    const out = await listManualReviewRefunds({ fetchImpl });
    expect(out).toHaveLength(2);
    const incomplete = out.find((e) => e.incomplete);
    expect(incomplete).toBeDefined();
    expect(incomplete?.sale_id).toBeNull();
    expect(incomplete?.provider).toBe("polar");
    expect(out.filter((e) => !e.incomplete)).toHaveLength(1);
  });

  it("respects an explicit limit override in the request URL", async () => {
    vi.stubEnv("SUPABASE_URL", URL_BASE);
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    const { fetchImpl, captured } = captureFetch([]);
    await listManualReviewRefunds({ fetchImpl, limit: 7 });
    expect(captured.url).toContain("&limit=7");
    expect(captured.url).not.toContain("limit=200");
  });

  it("throws on HTTP 500", async () => {
    vi.stubEnv("SUPABASE_URL", URL_BASE);
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    const { fetchImpl } = captureFetch({ message: "boom" }, 500);
    await expect(listManualReviewRefunds({ fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  it("returns [] when Supabase is unconfigured", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const { fetchImpl } = captureFetch([]);
    await expect(listManualReviewRefunds({ fetchImpl })).resolves.toEqual([]);
  });
});
