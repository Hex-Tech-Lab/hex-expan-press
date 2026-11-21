// productPriceUsd is the one money-path price rule for buyer surfaces. The prod DB CHECK is (price_usd IS NULL OR price_usd > 0),
// so a value the parser accepts must be a finite, positive, plain decimal. Anything else means "not for sale yet" (null).
import { describe, expect, it } from "vitest";
import { productPriceUsd } from "../src/lib/product-purchasable";

describe("productPriceUsd: accepts only a finite positive plain decimal", () => {
  it.each([
    ["integer string", "39", 39],
    ["decimal string", "39.00", 39],
    ["leading-dot decimal", ".5", 0.5],
    ["number", 29, 29],
    ["padded string", "  12.50 ", 12.5],
  ])("%s -> %s", (_label, raw, expected) => {
    expect(productPriceUsd(raw)).toBe(expected);
  });

  it.each([
    ["zero string", "0"],
    ["zero decimal string", "0.00"],
    ["zero number", 0],
    ["negative string", "-5"],
    ["negative number", -5],
    ["negative zero", "-0"],
  ])("rejects %s (DB CHECK requires price_usd > 0)", (_label, raw) => {
    expect(productPriceUsd(raw)).toBeNull();
  });

  it.each([
    ["NaN number", Number.NaN],
    ["Infinity number", Number.POSITIVE_INFINITY],
    ["negative Infinity number", Number.NEGATIVE_INFINITY],
    ["Infinity string", "Infinity"],
    ["NaN string", "NaN"],
  ])("rejects %s", (_label, raw) => {
    expect(productPriceUsd(raw)).toBeNull();
  });

  it.each([
    ["hex string", "0x10"],
    ["exponent string", "1e3"],
    ["upper exponent string", "1E3"],
    ["binary string", "0b11"],
    ["octal string", "0o7"],
    ["comma-separated", "1,000"],
    ["currency symbol", "$39"],
    ["trailing letters", "39USD"],
  ])("rejects non-decimal string %s", (_label, raw) => {
    expect(productPriceUsd(raw)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["blank string", "   "],
    ["boolean", true],
    ["object", {}],
  ])("rejects %s", (_label, raw) => {
    expect(productPriceUsd(raw)).toBeNull();
  });
});
