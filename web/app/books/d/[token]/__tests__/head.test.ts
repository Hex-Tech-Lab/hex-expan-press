import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { HEAD } from "../route";

const maybeSingleMock = vi.fn();
const insertMock = vi.fn();
const createSignedUrlMock = vi.fn();
const fakeSb = {
  from: vi.fn(() => ({
    select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: maybeSingleMock })) })) })),
    insert: insertMock,
  })),
  storage: { from: vi.fn(() => ({ createSignedUrl: createSignedUrlMock })) },
};
vi.mock("../../../../../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => fakeSb) }));

const TOKEN = "A".repeat(43);
const call = (token: string) =>
  HEAD(new NextRequest(`http://localhost/books/d/${token}`, { method: "HEAD" }), { params: Promise.resolve({ token }) });

describe("HEAD /books/d/[token] (non-logging)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 for a live link, with no signing and no download_completed insert", async () => {
    maybeSingleMock.mockResolvedValue({ data: { sale_id: "s", product_id: "p", expires_at: new Date(Date.now() + 3600e3).toISOString() }, error: null });
    const res = await call(TOKEN);
    expect(res.status).toBe(200);
    expect(insertMock).not.toHaveBeenCalled();
    expect(createSignedUrlMock).not.toHaveBeenCalled();
  });
  it("404 for a malformed token without touching the DB", async () => {
    expect((await call("short")).status).toBe(404);
    expect(maybeSingleMock).not.toHaveBeenCalled();
  });
  it("404 for an unknown token", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    expect((await call(TOKEN)).status).toBe(404);
    expect(insertMock).not.toHaveBeenCalled();
  });
  it("410 for an expired link", async () => {
    maybeSingleMock.mockResolvedValue({ data: { sale_id: "s", product_id: "p", expires_at: new Date(Date.now() - 1000).toISOString() }, error: null });
    expect((await call(TOKEN)).status).toBe(410);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
