// Admin allowlist parsing: env wins over global.json, an empty/commas-only env
// counts as unset, malformed ids fail closed (empty allowlist), ids lowercased.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdminSection } from "../src/settings_registry.ts";

const A = "AAAAAAAA-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadAdminSection", () => {
  it("defaults to an empty allowlist (nobody is admin)", () => {
    vi.stubEnv("ADMIN_USER_IDS", undefined);
    expect(loadAdminSection(undefined).admin_user_ids).toEqual([]);
  });

  it("env ADMIN_USER_IDS wins over global.json, lowercased", () => {
    vi.stubEnv("ADMIN_USER_IDS", ` ${A} `);
    expect(loadAdminSection({ admin_user_ids: [B] }).admin_user_ids).toEqual([A.toLowerCase()]);
  });

  it("an empty or commas-only env falls back to global.json", () => {
    vi.stubEnv("ADMIN_USER_IDS", " , ,");
    expect(loadAdminSection({ admin_user_ids: [B] }).admin_user_ids).toEqual([B]);
  });

  it("a malformed id fails closed to an empty allowlist", () => {
    vi.stubEnv("ADMIN_USER_IDS", `${A},not-a-uuid`);
    expect(loadAdminSection(undefined).admin_user_ids).toEqual([]);
  });

  it("an out-of-range page size falls back to the default", () => {
    vi.stubEnv("ADMIN_AUDIT_LOG_PAGE_SIZE", "0");
    expect(loadAdminSection(undefined).audit_log_page_size).toBe(50);
  });
});

describe("GLOBAL without global.json (production)", () => {
  it("still applies ADMIN_USER_IDS (data/settings is absent here, as in production)", async () => {
    vi.resetModules();
    vi.stubEnv("ADMIN_USER_IDS", A);
    const { GLOBAL } = await import("../src/settings_registry.ts");
    expect(GLOBAL.admin.admin_user_ids).toEqual([A.toLowerCase()]);
  });
});

