// Admin audit-log route: 401 signed out, 403 when not allowlisted (and when the
// allowlist is empty), 200 with a page of rows, 500 on read failure. No network.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  allowlist: [] as string[],
  result: { data: [] as unknown[] | null, error: null as { message: string } | null },
  range: [] as number[],
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../src/lib/supabase-server", () => ({
  getPortalSession: async () => (h.user ? { user: h.user, supabase: {} } : null),
}));
vi.mock("../../../../../../payments/src/settings_registry", () => ({
  GLOBAL: { admin: { get admin_user_ids() { return h.allowlist; }, audit_log_page_size: 2 } },
}));
vi.mock("@supabase/supabase-js", () => {
  const q = {
    select: () => q, in: () => q, order: () => q,
    range: async (from: number, to: number) => { h.range = [from, to]; return h.result; },
  };
  return { createClient: () => ({ from: () => q }) };
});

import { GET } from "../route";

const ADMIN = "00000000-0000-0000-0000-000000000001";
const req = (page?: string) => new NextRequest(`http://test/api/admin/audit-log${page ? `?page=${page}` : ""}`);
const row = (id: number) => ({ id, at: "2026-10-03T00:00:00Z", event: "MANUAL_REVIEW_REQUIRED_REFUND", details: {} });

beforeEach(() => {
  h.user = null; h.allowlist = []; h.range = [];
  h.result = { data: [], error: null };
  vi.stubEnv("SUPABASE_URL", "http://supabase.test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
});

describe("GET /api/admin/audit-log", () => {
  it("401 when signed out", async () => {
    expect((await GET(req())).status).toBe(401);
  });

  it("403 for everyone when the allowlist is empty (fail closed)", async () => {
    h.user = { id: ADMIN };
    expect((await GET(req())).status).toBe(403);
  });

  it("403 when signed in but not allowlisted", async () => {
    h.user = { id: ADMIN }; h.allowlist = ["11111111-1111-1111-1111-111111111111"];
    expect((await GET(req())).status).toBe(403);
  });

  it("200 with one page of rows and hasMore from the extra row", async () => {
    h.user = { id: ADMIN }; h.allowlist = [ADMIN];
    h.result = { data: [row(3), row(2), row(1)], error: null };
    const res = await GET(req("2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(h.range).toEqual([2, 4]);
    expect(body).toMatchObject({ ok: true, page: 2, pageSize: 2, hasMore: true });
    expect(body.rows.map((r: { id: number }) => r.id)).toEqual([3, 2]);
  });

  it("500 when the read fails", async () => {
    h.user = { id: ADMIN }; h.allowlist = [ADMIN];
    h.result = { data: null, error: { message: "boom" } };
    expect((await GET(req())).status).toBe(500);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
