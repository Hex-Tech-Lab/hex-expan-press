import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL, downloadOriginOverride, loadDeliverySection } from "../src/settings_registry.ts";

const ENV_KEYS = ["DELIVERY_DOWNLOAD_ORIGIN", "VERCEL_ENV", "NODE_ENV"] as const;
// A preview host must carry this team's suffix (hex-expan-press[-branch]-techhypexps-projects.vercel.app).
const PREVIEW = "https://hex-expan-press-git-test-techhypexps-projects.vercel.app";
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

describe("DELIVERY_DOWNLOAD_ORIGIN override (fail closed)", () => {
  it("applies the team-scoped preview origin on a Vercel preview build", () => {
    // Vercel preview builds run with NODE_ENV=production; the gate keys on VERCEL_ENV.
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = PREVIEW;
    expect(loadDeliverySection(undefined).download_origin).toBe(PREVIEW);
  });

  it("env value beats a file value, on a preview build", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = PREVIEW;
    expect(loadDeliverySection({ download_origin: "https://mail.expanpress.com" }).download_origin).toBe(PREVIEW);
  });

  it("refuses on Vercel production and falls back to the registry default", () => {
    process.env.VERCEL_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = PREVIEW;
    expect(loadDeliverySection(undefined).download_origin).toBe(DEFAULT_GLOBAL.delivery.download_origin);
  });

  it("refuses when both VERCEL_ENV and NODE_ENV are unset (fail closed, not open)", () => {
    delete process.env.VERCEL_ENV;
    delete process.env.NODE_ENV;
    expect(downloadOriginOverride(PREVIEW)).toBeNull();
  });

  it("refuses when NODE_ENV is production and VERCEL_ENV is unset", () => {
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = "production";
    expect(downloadOriginOverride(PREVIEW)).toBeNull();
  });

  it.each([
    ["plain http", "http://hex-expan-press-git-test-techhypexps-projects.vercel.app"],
    ["a path", `${PREVIEW}/books`],
    ["a query", `${PREVIEW}/?x=1`],
    ["a fragment", `${PREVIEW}/#x`],
    ["an explicit non-443 port", "https://test.expanpress.com:8443"],
    ["user credentials", "https://user:pass@test.expanpress.com"],
    ["a squatted project name without the team suffix", "https://hex-expan-press-git-main.vercel.app"],
    ["a project name with a suffix after the team", "https://hex-expan-press-x-techhypexps-projects.vercel.app.evil.test"],
    ["a vercel.app host outside the project", "https://some-other-app.vercel.app"],
    ["a bare vercel.app", "https://vercel.app"],
    ["a non-allowlisted host", "https://evil.example.com"],
    ["a suffix-spoofed host", "https://expanpress.com.evil.test"],
    ["not a URL", "not a url"],
  ])("refuses %s", (_label, origin) => {
    process.env.VERCEL_ENV = "preview";
    expect(downloadOriginOverride(origin)).toBeNull();
  });

  it("refuses the production apex on a preview (the apex is the production origin)", () => {
    process.env.VERCEL_ENV = "preview";
    expect(downloadOriginOverride("https://expanpress.com")).toBeNull();
  });

  it("accepts a subdomain of expanpress.com on a preview build", () => {
    process.env.VERCEL_ENV = "preview";
    expect(downloadOriginOverride("https://test.expanpress.com")).toBe("https://test.expanpress.com");
  });

  it("throws on a preview build when the override is refused (no silent fall-back to the production origin)", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NODE_ENV = "production";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = "https://expanpress.com"; // the production apex, refused on a preview
    expect(() => loadDeliverySection(undefined)).toThrow(/refused on a non-production build/);
  });

  it("throws on a test build when the override is refused", () => {
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = "test";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = "http://insecure.expanpress.com";
    expect(() => loadDeliverySection(undefined)).toThrow(/refused on a non-production build/);
  });

  it("ignores a refused override on production and uses the registry origin", () => {
    process.env.VERCEL_ENV = "production";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = "https://evil.example";
    expect(loadDeliverySection(undefined).download_origin).toBe(DEFAULT_GLOBAL.delivery.download_origin);
  });

  it("treats an empty DELIVERY_DOWNLOAD_ORIGIN as unset", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = "   ";
    expect(loadDeliverySection(undefined)).toEqual(DEFAULT_GLOBAL.delivery);
  });

  it("treats a scalar or array delivery section as absent instead of throwing", () => {
    delete process.env.DELIVERY_DOWNLOAD_ORIGIN;
    expect(() => loadDeliverySection("oops" as never)).not.toThrow();
    expect(loadDeliverySection("oops" as never)).toEqual(DEFAULT_GLOBAL.delivery);
    expect(loadDeliverySection([] as never)).toEqual(DEFAULT_GLOBAL.delivery);
  });
});
