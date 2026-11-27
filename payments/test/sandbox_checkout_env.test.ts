import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test-controlled view of data/settings/global.json so file-baseline tests never depend on disk state.
const fsState = vi.hoisted(() => ({ globalJson: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: string) => {
      if (String(p).endsWith("/data/settings/global.json")) return fsState.globalJson !== undefined;
      return actual.existsSync(p);
    },
    readFileSync: (p: string, enc: BufferEncoding) => {
      if (String(p).endsWith("/data/settings/global.json") && fsState.globalJson !== undefined) {
        return fsState.globalJson;
      }
      return actual.readFileSync(p, enc);
    },
  };
});

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
    fsState.globalJson = undefined;
  });

  afterEach(() => {
    fsState.globalJson = undefined;
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    vi.restoreAllMocks();
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

  it("env 'false' overrides a file value of true", async () => {
    fsState.globalJson = JSON.stringify({ payments: { sandbox_checkout_enabled: true } });

    // Negative control: without the env override, the true file baseline stays in effect.
    expect(await loadSandboxFlag(undefined)).toBe(true);
    expect(await loadSandboxFlag("false")).toBe(false);
  });

  it("unrecognized env 'yes' is ignored: the file value stays in effect and console.error names SANDBOX_CHECKOUT_ENABLED", async () => {
    fsState.globalJson = JSON.stringify({ payments: { sandbox_checkout_enabled: true } });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await loadSandboxFlag("yes")).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("SANDBOX_CHECKOUT_ENABLED"));

      // Negative control: when env is unset, SANDBOX_CHECKOUT_ENABLED is not reported as unrecognized.
      errSpy.mockClear();
      expect(await loadSandboxFlag(undefined)).toBe(true);
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("SANDBOX_CHECKOUT_ENABLED"));
    } finally {
      errSpy.mockRestore();
    }
  });
});
