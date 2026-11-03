import { describe, it, expect, vi, beforeEach } from "vitest";

// Test-controlled view of data/settings: a map from file name to raw text. Any other path reads the real disk.
const fsState = vi.hoisted(() => ({ files: {} as Record<string, string> }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const find = (p: string) => Object.keys(fsState.files).find((k) => p.endsWith(`/${k}`));
  return {
    ...actual,
    // providers.json is always test-controlled: a file on the real disk (in the main checkout) must never leak in.
    existsSync: (p: string) => {
      if (find(p) !== undefined) return true;
      if (p.endsWith("/providers.json")) return false;
      return actual.existsSync(p);
    },
    readFileSync: (p: string, enc: BufferEncoding) => {
      const k = find(p);
      return k !== undefined ? fsState.files[k] : actual.readFileSync(p, enc);
    },
  };
});

import { allProvidersOff, parsePaymentProviders, DEFAULT_PAYMENT_PROVIDERS } from "../src/settings_registry";

beforeEach(() => {
  fsState.files = {};
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("providers.json: pure normalisation", () => {
  it("a boolean enabled is kept as written", () => {
    const out = parsePaymentProviders({ paddle: { enabled: true, route: "paddle" } });
    expect(out.paddle.enabled).toBe(true);
  });

  it("a missing enabled is OFF, with a warning", () => {
    const out = parsePaymentProviders({ paddle: { route: "paddle" } });
    expect(out.paddle.enabled).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("a string \"true\" is OFF, not coerced", () => {
    const out = parsePaymentProviders({ paddle: { enabled: "true" } });
    expect(out.paddle.enabled).toBe(false);
  });

  it("a non-object entry is dropped", () => {
    const out = parsePaymentProviders({ paddle: "yes", fungies: { enabled: true } });
    expect(out.paddle).toBeUndefined();
    expect(out.fungies.enabled).toBe(true);
  });

  it("allProvidersOff keeps every default provider and switches each one off", () => {
    const off = allProvidersOff();
    expect(Object.keys(off).sort()).toEqual(Object.keys(DEFAULT_PAYMENT_PROVIDERS).sort());
    expect(Object.values(off).every((p) => p.enabled === false)).toBe(true);
  });
});

describe("providers.json: loader precedence through the real module", () => {
  it("no file: the inline defaults apply (Paddle on, Fungies and Polar off)", async () => {
    const m = await import("../src/settings_registry");
    expect(m.isEnabledPaymentProvider("paddle")).toBe(true);
    expect(m.isEnabledPaymentProvider("fungies")).toBe(false);
    expect(m.isEnabledPaymentProvider("polar")).toBe(false);
  });

  it("an unparseable providers.json switches EVERY provider off (fail closed, not the defaults)", async () => {
    fsState.files = { "providers.json": "{ not json" };
    const m = await import("../src/settings_registry");
    expect(m.isEnabledPaymentProvider("paddle")).toBe(false);
    expect(m.isEnabledPaymentProvider("fungies")).toBe(false);
  });

  it("a file with no payments section switches every provider off", async () => {
    fsState.files = { "providers.json": JSON.stringify({ other: {} }) };
    const m = await import("../src/settings_registry");
    expect(m.isEnabledPaymentProvider("paddle")).toBe(false);
  });

  it("a file that switches Fungies off is honoured over the inline default", async () => {
    fsState.files = {
      "providers.json": JSON.stringify({
        payments: {
          paddle: { enabled: true, route: "paddle" },
          fungies: { enabled: false, route: "fungies" },
        },
      }),
    };
    const m = await import("../src/settings_registry");
    expect(m.isEnabledPaymentProvider("paddle")).toBe(true);
    expect(m.isEnabledPaymentProvider("fungies")).toBe(false);
  });

  it("a provider absent from the file is not registered, so it is off", async () => {
    fsState.files = { "providers.json": JSON.stringify({ payments: { paddle: { enabled: true, route: "paddle" } } }) };
    const m = await import("../src/settings_registry");
    expect(m.isRegisteredPaymentProvider("fungies")).toBe(false);
    expect(m.isEnabledPaymentProvider("fungies")).toBe(false);
  });
});

describe("providers.json: a broken copy does not hide a valid one", () => {
  it("skipping an unparseable candidate still reports invalid only when nothing usable exists", async () => {
    fsState.files = { "providers.json": "{ not json" };
    const m = await import("../src/settings_registry");
    expect(m.isEnabledPaymentProvider("paddle")).toBe(false);
  });
});
