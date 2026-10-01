import { describe, expect, it } from "vitest";
import { primaryPaddle, resolvePaddlePrice } from "../bake_checkout";

const opts = {
  priceId: "pri_test123",
  clientToken: "live_testtoken123",
  productId: "test_product",
  environment: "production" as const,
};

describe("primaryPaddle", () => {
  it("renders one item, quantity 1, with the given priceId and productId", () => {
    const html = primaryPaddle("cfg.json", opts);
    expect(html).toContain(`"priceId":"pri_test123"`);
    expect(html).toContain(`"quantity":1`);
    expect(html).toContain(`items: [{"priceId":"pri_test123","quantity":1}]`);
    expect(html).toContain(`"product_id":"test_product"`);
  });

  it("marks the slot as paddle mode with a disabled button", () => {
    const html = primaryPaddle("cfg.json", opts);
    expect(html).toContain(`data-checkout-mode="paddle"`);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  it("production environment does not set Paddle.Environment", () => {
    const html = primaryPaddle("cfg.json", { ...opts, environment: "production" });
    expect(html).not.toContain("Paddle.Environment.set");
  });

  it("sandbox environment sets Paddle.Environment", () => {
    const html = primaryPaddle("cfg.json", { ...opts, environment: "sandbox" });
    expect(html).toContain(`Paddle.Environment.set("sandbox")`);
  });

  it("emits data-paddle-cdn on the script tag and selects by attribute, not src concat", () => {
    const html = primaryPaddle("cfg.json", opts);
    expect(html).toMatch(/<script [^>]*src="https:\/\/cdn\.paddle\.com\/paddle\/v2\/paddle\.js"[^>]*data-paddle-cdn><\/script>/);
    expect(html).toContain(`querySelector('script[data-paddle-cdn]')`);
    expect(html).not.toMatch(/querySelector\('script\[src="/);
  });

  it("throws on invalid priceId", () => {    expect(() => primaryPaddle("cfg.json", { ...opts, priceId: "pri_" })).toThrow();
    expect(() => primaryPaddle("cfg.json", { ...opts, priceId: "PRI_TEST123" })).toThrow();
  });

  it("throws on invalid clientToken", () => {
    expect(() => primaryPaddle("cfg.json", { ...opts, clientToken: "bad_token" })).toThrow();
  });

  it("throws on invalid productId", () => {
    expect(() => primaryPaddle("cfg.json", { ...opts, productId: "Test-Product" })).toThrow();
  });

  it("throws on quote-injection in priceId", () => {
    expect(() => primaryPaddle("cfg.json", { ...opts, priceId: 'pri_test"' })).toThrow();
  });

  it("throws on script-injection in priceId", () => {
    expect(() =>
      primaryPaddle("cfg.json", { ...opts, priceId: "pri_test</script>" }),
    ).toThrow();
  });
});

describe("resolvePaddlePrice", () => {
  it("throws in sandbox mode when paddle_price_id_sandbox is missing", () => {
    const cfg = { paddle_price_id: "pri_live123" };
    expect(() => resolvePaddlePrice(cfg, "sandbox")).toThrow(
      /checkout_mode=paddle requires paddle_price_id_sandbox/,
    );
  });

  it("returns sandbox price when present in sandbox mode", () => {
    const cfg = { paddle_price_id: "pri_live123", paddle_price_id_sandbox: "pri_test123" };
    expect(resolvePaddlePrice(cfg, "sandbox")).toBe("pri_test123");
  });

  it("returns production price in production mode", () => {
    const cfg = { paddle_price_id: "pri_live123" };
    expect(resolvePaddlePrice(cfg, "production")).toBe("pri_live123");
  });
});
