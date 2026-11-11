import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("dotenv", () => ({ default: { config } }));

import { resetSyncTestEnv } from "./sync-supabase-to-r2.harness";

// Every host variable the harness clears (sync-supabase-to-r2.harness.ts resetSyncTestEnv). Keep in step with it.
const HOST_VARS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_R2_ACCESS_KEY_ID",
  "CLOUDFLARE_R2_ACCOUNT_ID",
  "CLOUDFLARE_R2_BUCKET",
  "CLOUDFLARE_R2_BUCKET_NAME",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "R2_ALLOW_INSECURE_HTTP",
  "R2_ENDPOINT",
  "R2_REGION",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_STORAGE_BUCKET",
] as const;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("sync module .env handling", () => {
  it("does not read .env when the module is imported", async () => {
    config.mockClear();
    await import("../sync-supabase-to-r2");
    expect(config).not.toHaveBeenCalled();
  });

  it("loads the repo-root .env with override when the CLI path runs", async () => {
    config.mockClear();
    const mod = await import("../sync-supabase-to-r2");
    mod.loadEnvForCli();
    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith({ override: true, path: path.join(repoRoot, ".env") });
  });
});

describe("sync suite env isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const k of HOST_VARS) delete process.env[k];
  });

  it("resetSyncTestEnv clears every host variable pinned in HOST_VARS", () => {
    for (const k of HOST_VARS) process.env[k] = "poisoned";
    resetSyncTestEnv();
    for (const k of HOST_VARS) expect(process.env[k], k).toBeUndefined();
  });
});
