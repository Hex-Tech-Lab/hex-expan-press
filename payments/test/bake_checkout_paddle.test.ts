import { describe, expect, it } from "vitest";
import { primaryPaddle } from "../bake_checkout";

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

  it("throws on invalid priceId", () => {
    expect(() => primaryPaddle("cfg.json", { ...opts, priceId: "pri_" })).toThrow();
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
