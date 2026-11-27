import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression: DELIVERY_DOWNLOAD_ORIGIN must reach GLOBAL.delivery.download_origin through the global loader, not only through
// loadDeliverySection. Production and preview builds ship no global.json, so the loader's no-file path must apply the override.
// The branch alias is the only accepted preview host (see downloadOriginOverride).

const BRANCH_ALIAS = "https://hex-expan-press-git-fix-email-strea-b16b58-techhypexps-projects.vercel.app";
const ENV_KEYS = ["DELIVERY_DOWNLOAD_ORIGIN", "VERCEL_ENV", "NODE_ENV"] as const;

describe("DELIVERY_DOWNLOAD_ORIGIN reaches GLOBAL through the global loader", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("applies the branch-alias override on a preview build", async () => {
    vi.resetModules();
    process.env.VERCEL_ENV = "preview";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = BRANCH_ALIAS;
    const mod = await import("../src/settings_registry.ts");
    expect(mod.GLOBAL.delivery.download_origin).toBe(BRANCH_ALIAS);
  });

  it("keeps the registry origin when the override is not set", async () => {
    vi.resetModules();
    process.env.VERCEL_ENV = "preview";
    delete process.env.DELIVERY_DOWNLOAD_ORIGIN;
    const mod = await import("../src/settings_registry.ts");
    expect(mod.GLOBAL.delivery.download_origin).toBe(mod.DEFAULT_GLOBAL.delivery.download_origin);
  });

  it("refuses the production apex even when set on a preview build", async () => {
    vi.resetModules();
    process.env.VERCEL_ENV = "preview";
    process.env.DELIVERY_DOWNLOAD_ORIGIN = "https://expanpress.com";
    await expect(import("../src/settings_registry.ts")).rejects.toThrow(/DELIVERY_DOWNLOAD_ORIGIN refused/);
  });
});
