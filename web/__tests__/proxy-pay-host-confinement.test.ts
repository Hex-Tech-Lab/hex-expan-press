// Pay-host confinement in the normal vitest run (F-23).
//
// web/e2e/b2c-confinement.spec.ts test (d) asserts these rules against a live pay hostname, and it stays
// skipped unless PAY_HOST_LIVE is set, so no CI job runs it. This file asserts the same host-gating rules
// directly on proxy(): the request URL carries the pay hostname, and the proxy decides from that alone.
// Pay-host requests return before any Supabase call, so no mocks are needed here.
import { describe, it, expect } from "vitest";

function hostRequest(url: string): unknown {
  return { cookies: { getAll: () => [], set: () => undefined }, url, headers: new Headers() };
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
});
