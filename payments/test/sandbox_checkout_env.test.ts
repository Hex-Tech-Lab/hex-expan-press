import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SANDBOX_CHECKOUT_ENABLED overrides payments.sandbox_checkout_enabled. The registry loads once at import, so each case
// resets the module cache before importing.
const ENV = "SANDBOX_CHECKOUT_ENABLED";

async function loadSandboxFlag(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  const mod = await import("../src/settings_registry.ts");
  return mod.GLOBAL.payments.sandbox_checkout_enabled;
}

describe("SANDBOX_CHECKOUT_ENABLED env override", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    vi.resetModules();
  });

  it("is off by default (no env set)", async () => {
    expect(await loadSandboxFlag(undefined)).toBe(false);
  });

  it("true turns sandbox checkout on, regardless of case and spacing", async () => {
    expect(await loadSandboxFlag("true")).toBe(true);
    expect(await loadSandboxFlag(" TRUE ")).toBe(true);
  });

  it("false keeps it off", async () => {
    expect(await loadSandboxFlag("false")).toBe(false);
  });

  it("any other value is ignored and the default stays", async () => {
    expect(await loadSandboxFlag("yes")).toBe(false);
    expect(await loadSandboxFlag("1")).toBe(false);
    expect(await loadSandboxFlag("")).toBe(false);
  });
});
