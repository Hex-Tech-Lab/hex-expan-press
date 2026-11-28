import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

// A buyer-facing failure must reach Sentry, not only the console: a missing admin client is a full outage.
const captureException = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({ captureException }));

const getSupabaseAdminMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

describe("download route failures reach Sentry", () => {
  beforeEach(() => {
    captureException.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a missing admin client returns 500 and sends a Sentry event tagged download_route / admin_client_missing", async () => {
    const token = "A".repeat(43);
    const res = await GET(new NextRequest(`https://expanpress.com/books/d/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ surface: "download_route", reason: "admin_client_missing" }),
      }),
    );
  });

  it("the Sentry detail never carries the raw token", async () => {
    const token = "C".repeat(43);
    await GET(new NextRequest(`https://expanpress.com/books/d/${token}`), {
      params: Promise.resolve({ token }),
    });
    const messages = captureException.mock.calls.map((call) => String((call[0] as Error).message));
    expect(messages.join("\n")).not.toContain(token);
  });
});
