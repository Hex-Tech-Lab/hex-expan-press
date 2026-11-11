import { afterEach, describe, expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("dotenv", () => ({ default: { config } }));

import { resetSyncTestEnv } from "./sync-supabase-to-r2.harness";

const HOST_VARS = ["R2_ENDPOINT", "R2_REGION", "R2_ALLOW_INSECURE_HTTP", "SUPABASE_STORAGE_BUCKET"] as const;

describe("sync module .env handling", () => {
  it("does not read .env when the module is imported", async () => {
    await import("../sync-supabase-to-r2");
    expect(config).not.toHaveBeenCalled();
  });
});

describe("sync suite env isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const k of HOST_VARS) delete process.env[k];
  });

  it("resetSyncTestEnv clears every host variable the source reads", () => {
    for (const k of HOST_VARS) process.env[k] = "poisoned";
    resetSyncTestEnv();
    for (const k of HOST_VARS) expect(process.env[k], k).toBeUndefined();
  });
});
