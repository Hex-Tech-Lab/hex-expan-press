import { describe, expect, it, vi } from "vitest";
import {
  assertSandboxOnly,
  buildSamplePayloads,
  describeHttpStatus,
  provisionSandboxSampleProduct,
  resolveBookPath,
} from "../../scripts/paddle_sandbox_sample_product.ts";
import { loadBookIdentity } from "../book_identity.ts";
import { GLOBAL } from "../src/settings_registry.ts";

describe("paddle_sandbox_sample_product: sandbox-only guards", () => {
  it("refuses live API key (pdl_live_*), unknown key prefix, live base URL, and production flags", () => {
    expect(() =>
      assertSandboxOnly("https://api.paddle.com", "pdl_sdbx_apikey_abc", {}),
    ).toThrow(/non-sandbox Paddle base URL/);
    expect(() =>
      assertSandboxOnly("https://sandbox-api.paddle.com", "pdl_live_apikey_abc", {}),
    ).toThrow(/live Paddle API key/);
    expect(() =>
      assertSandboxOnly("https://sandbox-api.paddle.com", "arbitrary_key", {}),
    ).toThrow(/must start with pdl_sdbx_/);
    expect(() =>
      assertSandboxOnly("https://sandbox-api.paddle.com", "pdl_sdbx_apikey_abc", { PADDLE_ENVIRONMENT: "production" }),
    ).toThrow(/production environment flag/);
    expect(() =>
      assertSandboxOnly("https://sandbox-api.paddle.com", "pdl_sdbx_apikey_abc", { VERCEL_ENV: "production" }),
    ).toThrow(/production environment flag/);
    expect(() =>
      assertSandboxOnly("https://sandbox-api.paddle.com", "pdl_sdbx_apikey_abc", { NODE_ENV: "production" }),
    ).toThrow(/production environment flag/);
    expect(assertSandboxOnly("https://sandbox-api.paddle.com", "pdl_sdbx_apikey_abc", {})).toBe("pdl_sdbx_apikey_abc");
  });

  it("names HTTP status codes with their meanings", () => {
    expect(describeHttpStatus(200)).toBe("200 OK");
    expect(describeHttpStatus(201)).toBe("201 Created");
    expect(describeHttpStatus(401)).toBe("401 Unauthorized");
    expect(describeHttpStatus(403)).toBe("403 Forbidden");
  });
});

describe("paddle_sandbox_sample_product: SSOT + registry derivation", () => {
  it("builds product and 9 USD one-time price payloads from books/sample_the_quiet_workshop.json and settings_registry", () => {
    const identity = loadBookIdentity(resolveBookPath("sample_the_quiet_workshop"));
    const built = buildSamplePayloads(identity);
    expect(built.productPayload).toEqual({
      name: "The Quiet Workshop (Sample)",
      description: "Twelve Practical Projects for a Small Home Bench",
      tax_category: GLOBAL.payments.paddle.product_tax_category,
      custom_data: {
        store_product_id: "house_sample_the_quiet_workshop_v1",
        product_slug: "sample_the_quiet_workshop",
      },
    });
    expect(built.taxCategory).toBe("ebooks");
    expect(built.pricePayloadTemplate.unit_price).toEqual({ amount: "900", currency_code: "USD" });
    expect(built.pricePayloadTemplate.billing_cycle).toBeNull();
    expect(built.pricePayloadTemplate.tax_mode).toBe("account_setting");
  });

  it("dry-run returns derived payloads without making any network request", async () => {
    const fetchSpy = vi.fn();
    const res = await provisionSandboxSampleProduct({
      dryRun: true,
      env: {},
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.dryRun).toBe(true);
    expect(res.apiBase).toBe("https://sandbox-api.paddle.com");
    expect(res.productId).toBeNull();
    expect(res.priceId).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates product (201 Created) and one-time price (201 Created) and verifies via GET (200 OK)", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && url.includes("/products?")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (method === "POST" && url.endsWith("/products")) {
        return new Response(JSON.stringify({ data: { id: "pro_sdbx_123" } }), { status: 201 });
      }
      if (method === "GET" && url.includes("/prices?")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (method === "POST" && url.endsWith("/prices")) {
        return new Response(JSON.stringify({ data: { id: "pri_sdbx_456" } }), { status: 201 });
      }
      if (method === "GET" && url.endsWith("/products/pro_sdbx_123")) {
        return new Response(JSON.stringify({ data: { id: "pro_sdbx_123", name: "The Quiet Workshop (Sample)" } }), { status: 200 });
      }
      if (method === "GET" && url.endsWith("/prices/pri_sdbx_456")) {
        return new Response(JSON.stringify({ data: { id: "pri_sdbx_456", product_id: "pro_sdbx_123" } }), { status: 200 });
      }
      return new Response("unexpected", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await provisionSandboxSampleProduct({
      env: { [GLOBAL.payments.paddle.sandbox_api_key_env]: "pdl_sdbx_apikey_test" },
      fetchImpl: fetchMock,
    });
    expect(res.productCreated).toBe(true);
    expect(res.priceCreated).toBe(true);
    expect(res.productId).toBe("pro_sdbx_123");
    expect(res.priceId).toBe("pri_sdbx_456");
    expect(res.verifiedStatus).toEqual({ product: "200 OK", price: "200 OK" });
    expect(calls.every((c) => c.url.startsWith("https://sandbox-api.paddle.com/"))).toBe(true);
  });
});
