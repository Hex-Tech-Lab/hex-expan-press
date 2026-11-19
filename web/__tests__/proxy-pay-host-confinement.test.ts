// Pay-host confinement in the normal vitest run (F-23).
//
// web/e2e/b2c-confinement.spec.ts test (d) asserts these rules against a live pay hostname, and it stays
// skipped unless PAY_HOST_LIVE is set, so no CI job runs it. This file asserts the same host-gating rules
// directly on proxy(): the request URL carries the pay hostname, and the proxy decides from that alone.
// Pay-host requests return before any Supabase call, so no mocks are needed here.
import { describe, it, expect } from "vitest";

function hostRequest(url: string, headers: Record<string, string> = {}, method = "GET"): unknown {
  return { cookies: { getAll: () => [], set: () => undefined }, url, method, headers: new Headers(headers) };
}

describe("pay host confinement (b2c-confinement spec, test d)", () => {
  it("pay /terms.html is 404 (creator legal set is not served on pay)", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://pay.expanpress.com/terms.html") as never);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("pay /books is 404 (the B2C landing lives on the main host)", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://pay.expanpress.com/books") as never);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("pay /books/legal/terms.html is served (buyer legal set)", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://pay.expanpress.com/books/legal/terms.html") as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("control: the same paths on the main host are not 404, so the pay 404s come from the host", async () => {
    const { proxy } = await import("../proxy");
    for (const path of ["/terms.html", "/books", "/books/legal/terms.html"]) {
      const res = await proxy(hostRequest(`https://expanpress.com${path}`) as never);
      expect(res.status, path).not.toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("blocks non-US x-vercel-ip-country on pay checkout page and API with 403 while allowing US and buyer legal pages", async () => {
    const { proxy } = await import("../proxy");
    const blockedPage = await proxy(hostRequest("https://pay.expanpress.com/checkout/p1", { "x-vercel-ip-country": "DE" }) as never);
    expect(blockedPage.status).toBe(403);

    const blockedApi = await proxy(hostRequest("https://pay.expanpress.com/api/billing/checkout?product=p1", { "x-vercel-ip-country": "DE" }) as never);
    expect(blockedApi.status).toBe(403);
    expect(await blockedApi.json()).toMatchObject({ ok: false, code: "country_not_supported" });

    const blockedHead = await proxy(hostRequest("https://pay.expanpress.com/api/billing/checkout?product=p1", { "x-vercel-ip-country": "GB" }, "HEAD") as never);
    expect(blockedHead.status).toBe(403);
    expect(await blockedHead.text()).toBe("");

    const allowedUs = await proxy(hostRequest("https://pay.expanpress.com/checkout/p1", { "x-vercel-ip-country": "US" }) as never);
    expect(allowedUs.status).toBe(200);

    const allowedLegal = await proxy(hostRequest("https://pay.expanpress.com/books/legal/terms.html", { "x-vercel-ip-country": "DE" }) as never);
    expect(allowedLegal.status).toBe(200);
  });
});
