import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL, downloadOriginOverride, loadDeliverySection } from "../src/settings_registry.ts";

const ENV_KEYS = ["DELIVERY_DOWNLOAD_ORIGIN", "VERCEL_ENV", "NODE_ENV"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("DELIVERY_DOWNLOAD_ORIGIN override (test deployments only)", () => {
  it("applies an allowlisted https preview origin outside Vercel production", () => {
    // Vercel preview builds run with NODE_ENV=production, so the guard must allow them.
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = "https://hex-expan-test.vercel.app";
    expect(loadDeliverySection(undefined).download_origin).toBe("https://hex-expan-test.vercel.app");
  });

  it("refuses the override on Vercel production and falls back to the registry default", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = "https://hex-expan-test.vercel.app";
    expect(loadDeliverySection(undefined).download_origin).toBe(DEFAULT_GLOBAL.delivery.download_origin);
  });

  it("refuses the override when NODE_ENV is production and VERCEL_ENV is unset (non-Vercel production)", () => {
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = "production";
    expect(downloadOriginOverride("https://hex-expan-test.vercel.app")).toBeNull();
  });

  it.each([
    ["plain http", "http://hex-expan-test.vercel.app"],
    ["a path", "https://hex-expan-test.vercel.app/books"],
    ["a query", "https://hex-expan-test.vercel.app/?x=1"],
    ["a non-allowlisted host", "https://evil.example.com"],
    ["a suffix-spoofed host", "https://expanpress.com.evil.test"],
    ["not a URL", "not a url"],
  ])("refuses %s", (_label, origin) => {
    process.env.VERCEL_ENV = "preview";
    expect(downloadOriginOverride(origin)).toBeNull();
  });

  it("accepts expanpress.com and its subdomains outside production", () => {
    process.env.VERCEL_ENV = "preview";
    expect(downloadOriginOverride("https://expanpress.com")).toBe("https://expanpress.com");
    expect(downloadOriginOverride("https://test.expanpress.com")).toBe("https://test.expanpress.com");
  });
});
