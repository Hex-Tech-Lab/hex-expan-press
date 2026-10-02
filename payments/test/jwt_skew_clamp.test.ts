import { describe, expect, it } from "vitest";
import { clampJwtSkewDelay, DEFAULT_GLOBAL } from "../src/settings_registry.ts";

describe("portal jwt clock-skew clamp", () => {
  it("inline default is 350 and clamps to itself", () => {
    expect(DEFAULT_GLOBAL.portal.jwt_clock_skew_retry_delay_ms).toBe(350);
    expect(clampJwtSkewDelay(350)).toBe(350);
  });

  it("missing -> 350", () => {
    expect(clampJwtSkewDelay(undefined)).toBe(350);
  });

  it("below range clamps to 250 (100 -> 250)", () => {
    expect(clampJwtSkewDelay(100)).toBe(250);
  });

  it("above range clamps to 500 (9999 -> 500)", () => {
    expect(clampJwtSkewDelay(9999)).toBe(500);
  });

  it("NaN / Infinity / non-number -> 350", () => {
    expect(clampJwtSkewDelay(NaN)).toBe(350);
    expect(clampJwtSkewDelay(Infinity)).toBe(350);
    expect(clampJwtSkewDelay("300")).toBe(350);
    expect(clampJwtSkewDelay(null)).toBe(350);
  });

  it("in-range values pass through", () => {
    expect(clampJwtSkewDelay(250)).toBe(250);
    expect(clampJwtSkewDelay(500)).toBe(500);
    expect(clampJwtSkewDelay(499)).toBe(499);
  });
});
