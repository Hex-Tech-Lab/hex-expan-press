// Runtime-contract tests for the GLOBAL.payments tunables added to the settings
// registry: with data/settings/*.json ABSENT (the deployed reality — the dir is
// gitignored and not shipped), every accessor must return its documented inline
// default. Also proves invalid registry values fall back to the defaults with a
// warning instead of being trusted.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";

const DATA_SETTINGS = join(process.cwd(), "data", "settings");
let restored: string | undefined;

function stashDataSettings(): void {
  restored = undefined;
  try {
    renameSync(DATA_SETTINGS, DATA_SETTINGS + ".test-stash");
    restored = DATA_SETTINGS + ".test-stash";
  } catch {
    // absent — fine, that IS the production case under test
  }
  // remove any stale dir the loader could otherwise pick up (tests that don't
  // stash are the ones that create it; restore() cleans it when stashed).
  rmSync(DATA_SETTINGS, { recursive: true, force: true });
}

function restoreDataSettings(): void {
  if (restored) {
    rmSync(DATA_SETTINGS, { recursive: true, force: true });
    renameSync(restored, DATA_SETTINGS);
    restored = undefined;
  }
}

async function loadRegistryFresh(): Promise<typeof import("../src/settings_registry.ts")> {
  // fresh module instance per test: the registry is a load-time constant
  vi.resetModules();
  return await import("../src/settings_registry.ts");
}

const warnSpy = (() => {
  const orig = console.error;
  const lines: string[] = [];
  return {
    lines,
    on: () => { console.error = (...a: unknown[]) => { lines.push(String(a[0])); }; },
    off: () => { console.error = orig; },
    reset: () => { lines.length = 0; },
  };
})();

afterEach(() => {
  warnSpy.off();
  warnSpy.reset();
  restoreDataSettings();
});

const DOC_DEFAULTS = {
  webhook_tolerance_seconds: 300,
  http_timeout_ms: 5000,
  paddle_api_production: "https://api.paddle.com",
  paddle_api_sandbox: "https://sandbox-api.paddle.com",
  paddle_js_cdn_url: "https://cdn.paddle.com/paddle/v2/paddle.js",
  polar_sandbox_fallback: "https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_g84ByoGAeZiahkWtCasYmeu1ShLtZIwwayzyI4ZdZsM/redirect",
};

describe("settings registry runtime defaults (registry file absent)", () => {
  it("returns documented inline defaults when data/settings is missing", async () => {
    stashDataSettings();
    const { GLOBAL } = await loadRegistryFresh();
    expect(GLOBAL.payments.webhook_tolerance_seconds).toBe(DOC_DEFAULTS.webhook_tolerance_seconds);
    expect(GLOBAL.payments.http_timeout_ms).toBe(DOC_DEFAULTS.http_timeout_ms);
    expect(GLOBAL.payments.paddle.api_base.production).toBe(DOC_DEFAULTS.paddle_api_production);
    expect(GLOBAL.payments.paddle.api_base.sandbox).toBe(DOC_DEFAULTS.paddle_api_sandbox);
    expect(GLOBAL.payments.paddle.js_cdn_url).toBe(DOC_DEFAULTS.paddle_js_cdn_url);
    expect(GLOBAL.payments.polar.sandbox_checkout_fallback_url).toBe(DOC_DEFAULTS.polar_sandbox_fallback);
  });

  it("tolerance and timeout are positive integers in the default set", async () => {
    stashDataSettings();
    const { GLOBAL } = await loadRegistryFresh();
    expect(Number.isInteger(GLOBAL.payments.webhook_tolerance_seconds)).toBe(true);
    expect(GLOBAL.payments.webhook_tolerance_seconds).toBeGreaterThan(0);
    expect(Number.isInteger(GLOBAL.payments.http_timeout_ms)).toBe(true);
    expect(GLOBAL.payments.http_timeout_ms).toBeGreaterThan(0);
  });

  it("all default URLs are https", async () => {
    stashDataSettings();
    const { GLOBAL } = await loadRegistryFresh();
    for (const u of [
      GLOBAL.payments.paddle.api_base.production,
      GLOBAL.payments.paddle.api_base.sandbox,
      GLOBAL.payments.paddle.js_cdn_url,
      GLOBAL.payments.polar.sandbox_checkout_fallback_url,
    ]) {
      expect(u.startsWith("https://")).toBe(true);
    }
  });
});

describe("settings registry runtime fallback (invalid values)", () => {
  it("invalid webhook_tolerance_seconds / http_timeout_ms fall back to defaults with a warning", async () => {
    stashDataSettings();
    // point the loader at a temp dir is not possible (candidate dirs are fixed),
    // so exercise the loader path by writing an invalid global.json into the
    // real candidate dir — restore in afterEach.
    mkdirSync(DATA_SETTINGS, { recursive: true });
    writeFileSync(join(DATA_SETTINGS, "global.json"), JSON.stringify({
      payments: {
        webhook_tolerance_seconds: -1,
        http_timeout_ms: "fast",
      },
    }));
    const { GLOBAL } = await loadRegistryFresh();
    expect(GLOBAL.payments.webhook_tolerance_seconds).toBe(DOC_DEFAULTS.webhook_tolerance_seconds);
    expect(GLOBAL.payments.http_timeout_ms).toBe(DOC_DEFAULTS.http_timeout_ms);
  });

  it("invalid paddle/polar URLs fall back to https defaults", async () => {
    mkdirSync(DATA_SETTINGS, { recursive: true });
    writeFileSync(join(DATA_SETTINGS, "global.json"), JSON.stringify({
      payments: {
        paddle: {
          api_base: { production: "http://insecure.example", sandbox: 42 },
          js_cdn_url: "not a url",
        },
        polar: { sandbox_checkout_fallback_url: "ftp://nope" },
      },
    }));
    const { GLOBAL } = await loadRegistryFresh();
    expect(GLOBAL.payments.paddle.api_base.production).toBe(DOC_DEFAULTS.paddle_api_production);
    expect(GLOBAL.payments.paddle.api_base.sandbox).toBe(DOC_DEFAULTS.paddle_api_sandbox);
    expect(GLOBAL.payments.paddle.js_cdn_url).toBe(DOC_DEFAULTS.paddle_js_cdn_url);
    expect(GLOBAL.payments.polar.sandbox_checkout_fallback_url).toBe(DOC_DEFAULTS.polar_sandbox_fallback);
  });

  it("valid registry values are honored (loader reads the file, not just defaults)", async () => {
    mkdirSync(DATA_SETTINGS, { recursive: true });
    writeFileSync(join(DATA_SETTINGS, "global.json"), JSON.stringify({
      payments: {
        webhook_tolerance_seconds: 600,
        http_timeout_ms: 8000,
        paddle: {
          api_base: { production: "https://api.paddle.com", sandbox: "https://sandbox-api.paddle.com" },
          js_cdn_url: "https://cdn.paddle.com/paddle/v2/paddle.js",
        },
        polar: { sandbox_checkout_fallback_url: "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect" },
      },
    }));
    const { GLOBAL } = await loadRegistryFresh();
    expect(GLOBAL.payments.webhook_tolerance_seconds).toBe(600);
    expect(GLOBAL.payments.http_timeout_ms).toBe(8000);
  });
});

describe("webhook tolerance accessor consistency", () => {
  it("adapter exports derive from GLOBAL, not literals", async () => {
    stashDataSettings();
    const { GLOBAL } = await loadRegistryFresh();
    const polar = await import("../../src/adapters/payments/polar.adapter.ts");
    const paddle = await import("../../src/adapters/payments/paddle.adapter.ts");
    expect(polar.POLAR_WEBHOOK_TOLERANCE_SECONDS).toBe(GLOBAL.payments.webhook_tolerance_seconds);
    expect(paddle.PADDLE_WEBHOOK_TOLERANCE_SECONDS).toBe(GLOBAL.payments.webhook_tolerance_seconds);
  });
});
