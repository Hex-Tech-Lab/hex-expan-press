import { beforeEach, describe, expect, it, vi } from "vitest";

// The seam is the one place that builds service-role Supabase clients. These tests pin its transport guard: a plaintext
// URL must be refused before any client exists, on the sync path (createServiceClient) and on the production path
// (getSupabaseAdmin, used by the billing webhook audit and the admin audit read).
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({})) }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { assertSecureSupabaseUrl, createServiceClient, getSupabaseAdmin } from "../src/supabase_admin";

beforeEach(() => {
  createClient.mockClear();
  vi.unstubAllEnvs();
});

describe("Supabase service seam: transport guard", () => {
  it("refuses a plaintext non-loopback URL before any client is built", async () => {
    await expect(createServiceClient("http://remote-probe.example.test", "k")).rejects.toThrow(/must be https/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses a plaintext URL on the production path before any client is built", async () => {
    vi.stubEnv("SUPABASE_URL", "http://remote-probe.example.test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "k");
    await expect(getSupabaseAdmin()).rejects.toThrow(/must be https/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("builds a client for an https URL", async () => {
    await createServiceClient("https://project.supabase.co", "k");
    expect(createClient).toHaveBeenCalledWith("https://project.supabase.co", "k", undefined);
  });

  it("allows http only to loopback (localhost, 127.0.0.1, [::1])", async () => {
    await createServiceClient("http://localhost:54321", "k");
    await createServiceClient("http://127.0.0.1:54321", "k");
    await createServiceClient("http://[::1]:54321", "k");
    expect(createClient).toHaveBeenCalledTimes(3);
  });

  it("refuses lookalike hosts that only resemble loopback", async () => {
    for (const url of ["http://localhost.attacker.example:54321", "http://127.0.0.2:54321", "http://0.0.0.0:54321"]) {
      await expect(createServiceClient(url, "k"), url).rejects.toThrow(/must be https/);
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns null and builds nothing when the env is unset", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    expect(await getSupabaseAdmin()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses a malformed URL with the guard's message, not a bare TypeError", () => {
    expect(() => assertSecureSupabaseUrl("not a url")).toThrow(/not a valid URL/);
  });
});
