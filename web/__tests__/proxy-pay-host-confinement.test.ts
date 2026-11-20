// Pay-host confinement in the normal vitest run (F-23).
//
// web/e2e/b2c-confinement.spec.ts test (d) asserts these rules against a live pay hostname, and it stays
// skipped unless PAY_HOST_LIVE is set, so no CI job runs it. This file asserts the same host-gating rules
// directly on proxy(): the request URL carries the pay hostname, and the proxy decides from that alone.
// Pay-host requests return before any Supabase call, so no mocks are needed here.
import { afterEach, describe, it, expect, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";

function hostRequest(url: string, headers: Record<string, string> = {}, method = "GET"): unknown {
  return { cookies: { getAll: () => [], set: () => undefined }, url, method, headers: new Headers(headers) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pay host confinement (b2c-confinement spec, test d)", () => {
  it("pay / returns 200 OK pay-host landing page with B2C catalog link and buyer legal links (LV-05)", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(hostRequest("https://pay.expanpress.com/") as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await res.text();
    expect(html).toContain(GLOBAL.storefront.pay_root_heading);
    expect(html).toContain(GLOBAL.storefront.b2c_landing_url);
    expect(html).toContain(GLOBAL.storefront.browse_books_label);
    expect(html).toContain("/books/legal/privacy.html");
    expect(html).toContain("/books/legal/terms.html");
    expect(html).toContain("/books/legal/refund-policy.html");
    expect(html).toContain(GLOBAL.email.support);
    expect(html).not.toContain("/creator/");
    // Legal links and {expanpress} wordmark come from the registry and design tokens (no plain-text brand box).
    for (const link of GLOBAL.storefront.buyer_legal_links) {
      expect(html).toContain(`<a href="${link.path}">${link.label}</a>`);
    }
    expect(html).toContain(`<span class="brace">{</span><span class="name">${GLOBAL.storefront.brand_name.toLowerCase()}</span><span class="brace">}</span>`);
    expect(html).toContain(GLOBAL.storefront.pay_root_kicker);
    expect(html).not.toContain('<div class="brand">');
    expect(html).not.toContain("ExpanPress Checkout");

    const headRes = await proxy(hostRequest("https://pay.expanpress.com/", {}, "HEAD") as never);
    expect(headRes.status).toBe(200);
    expect(await headRes.text()).toBe("");
  });

  it("sets X-Robots-Tag noindex, nofollow on service-provider pages across hosts", async () => {
    const { proxy } = await import("../proxy");
    const payProviders = await proxy(hostRequest("https://pay.expanpress.com/books/legal/providers.html") as never);
    expect(payProviders.status).toBe(200);
    expect(payProviders.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const mainBuyerProviders = await proxy(hostRequest("https://expanpress.com/books/legal/providers.html") as never);
    expect(mainBuyerProviders.status).toBe(200);
    expect(mainBuyerProviders.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const mainCreatorProviders = await proxy(hostRequest("https://expanpress.com/legal/providers.html") as never);
    expect(mainCreatorProviders.status).toBe(200);
    expect(mainCreatorProviders.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("E2E_PROXY_HOST_OVERRIDE is ignored in production builds and on non-localhost URLs", async () => {
    const { proxy } = await import("../proxy");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_PROXY_HOST_OVERRIDE", "1");
    const prodRes = await proxy(hostRequest("http://localhost:3100/terms.html", { host: "pay.expanpress.com" }) as never);
    expect(prodRes.status).not.toBe(404);

    vi.stubEnv("NODE_ENV", "development");
    const nonLocalRes = await proxy(hostRequest("https://expanpress.com/terms.html", { host: "pay.expanpress.com" }) as never);
    expect(nonLocalRes.status).not.toBe(404);
  });

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
