import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const adminModule = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../../../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: async () => adminModule.client }));

import { GET } from "../route";
import { tokenHash } from "../../../../../payments/src/delivery";

const TOKEN = "A".repeat(43);
type Opts = { link?: unknown; linkErr?: boolean; product?: unknown; signedErr?: boolean; logErr?: boolean };
const inserts: unknown[] = [];

function client(o: Opts) {
  return {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => (o.linkErr ? { data: null, error: { message: "boom" } } : { data: o.link === undefined ? linkRow() : o.link, error: null }) }), maybeSingle: async () => ({ data: o.product === undefined ? { release_path: "p/file.pdf" } : o.product, error: null }) }),
        }),
        insert: async (row: unknown) => {
          inserts.push({ table, row });
          return { error: o.logErr ? { message: "log down" } : null };
        },
      };
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => (o.signedErr ? { data: null, error: { message: "nope" } } : { data: { signedUrl: "https://signed.example/file?t=1" }, error: null }),
      }),
    },
  };
}
const linkRow = (expires = Date.now() + 86_400_000) => ({ sale_id: "s-1", product_id: "p-1", expires_at: new Date(expires).toISOString() });
const call = (token: string) => GET(new NextRequest(`https://expanpress.com/d/${token}`), { params: Promise.resolve({ token }) });

describe("GET /d/{token}", () => {
  beforeEach(() => { inserts.length = 0; });

  it("rejects a malformed token without touching the database", async () => {
    adminModule.client = client({});
    const res = await call("short");
    expect(res.status).toBe(404);
  });

  it("404s an unknown token", async () => {
    adminModule.client = client({ link: null });
    expect((await call(TOKEN)).status).toBe(404);
  });

  it("410s an expired link", async () => {
    adminModule.client = client({ link: linkRow(Date.now() - 1000) });
    expect((await call(TOKEN)).status).toBe(410);
  });

  it("logs download_completed with the token hash, then 302s to the signed URL", async () => {
    adminModule.client = client({});
    const res = await call(TOKEN);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://signed.example/file?t=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const logged = inserts.find((i) => (i as { table: string }).table === "download_events") as { row: Record<string, unknown> };
    expect(logged.row.event_type).toBe("download_completed");
    expect(logged.row.token_hash).toBe(tokenHash(TOKEN));
    expect(JSON.stringify(inserts)).not.toContain(TOKEN);
  });

  it("serves nothing when the download log write fails (fail closed)", async () => {
    adminModule.client = client({ logErr: true });
    const res = await call(TOKEN);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("500s when the signed URL cannot be created", async () => {
    adminModule.client = client({ signedErr: true });
    expect((await call(TOKEN)).status).toBe(500);
  });

  it("500s when the product has no release file", async () => {
    adminModule.client = client({ product: { release_path: null } });
    expect((await call(TOKEN)).status).toBe(500);
  });
});
