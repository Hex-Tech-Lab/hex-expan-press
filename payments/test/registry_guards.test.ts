// Settings-registry guards from the PR 136 review: usage-watch hosts and timers, the delivery key name, and the
// stuck-claim window. Each guard falls back to the default instead of widening what the code may do.
import { describe, it, expect, vi } from "vitest";
import {
  loadUsageWatchSection,
  loadDeliverySection,
  DEFAULT_GLOBAL,
  CONSENT_EVIDENCE_SEGMENT_CONTRACT,
} from "../src/settings_registry";
import { listStuckDeliveryClaims } from "../src/delivery_sends_store";

describe("usage_watch endpoints: only HTTPS provider origins may receive credentials", () => {
  it("accepts the allowlisted origin, with or without a trailing slash", () => {
    const out = loadUsageWatchSection({ endpoints: { supabase_api: "https://api.supabase.com/", upstash_api: "https://api.upstash.com" } });
    expect(out.endpoints.supabase_api).toBe("https://api.supabase.com");
    expect(out.endpoints.upstash_api).toBe("https://api.upstash.com");
  });

  it.each([
    ["a foreign host", "https://evil.example"],
    ["plain http on the allowed host", "http://api.supabase.com"],
    ["userinfo in the URL", "https://user:pw@api.supabase.com"],
    ["a path", "https://api.supabase.com/v1"],
    ["a query string", "https://api.supabase.com/?x=1"],
    ["a lookalike suffix", "https://api.supabase.com.evil.example"],
    ["not a URL", "api.supabase.com"],
  ])("refuses %s and falls back to the default", (_label, value) => {
    const out = loadUsageWatchSection({ endpoints: { supabase_api: value } });
    expect(out.endpoints.supabase_api).toBe(DEFAULT_GLOBAL.usage_watch.endpoints.supabase_api);
  });

  it("refuses an Upstash override outside its own allowlisted origin", () => {
    const out = loadUsageWatchSection({ endpoints: { upstash_api: "https://api.supabase.com" } });
    expect(out.endpoints.upstash_api).toBe(DEFAULT_GLOBAL.usage_watch.endpoints.upstash_api);
  });
});

describe("usage_watch timeout_ms: a value Node timers accept", () => {
  it.each([0, 0.5, 1.5, -1, 2147483648, Number.NaN])("falls back for %p", (value) => {
    expect(loadUsageWatchSection({ timeout_ms: value }).timeout_ms).toBe(DEFAULT_GLOBAL.usage_watch.timeout_ms);
  });

  it("keeps a positive safe integer within the timer range", () => {
    expect(loadUsageWatchSection({ timeout_ms: 5000 }).timeout_ms).toBe(5000);
    expect(loadUsageWatchSection({ timeout_ms: 2147483647 }).timeout_ms).toBe(2147483647);
  });
});

describe("delivery.link_key_env: an env var NAME, never a value", () => {
  it("accepts a conventional env var name", () => {
    expect(loadDeliverySection({ link_key_env: "MY_LINK_KEY" }).link_key_env).toBe("MY_LINK_KEY");
  });

  it.each(["lower_case", "has space", "=VALUE", "A".repeat(65)])("falls back to the default for %p", (value) => {
    expect(loadDeliverySection({ link_key_env: value }).link_key_env).toBe(DEFAULT_GLOBAL.delivery.link_key_env);
  });
});

describe("listStuckDeliveryClaims window is validated before any query", () => {
  it.each([-1, Number.NaN, 1.5, 1e20, Number.POSITIVE_INFINITY])("rejects %p with a RangeError", async (value) => {
    await expect(listStuckDeliveryClaims(value)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("consent evidence segment contract is independent of registry overrides", () => {
  it("rejects a slash, a dot segment, and an unanchored match", () => {
    const { envelopeId } = CONSENT_EVIDENCE_SEGMENT_CONTRACT;
    expect(envelopeId.test("env_1")).toBe(true);
    expect(envelopeId.test("a/../b")).toBe(false);
    expect(envelopeId.test("x/y")).toBe(false);
    expect(envelopeId.test("env id")).toBe(false);
    expect(envelopeId.test("unknown/../../etc")).toBe(false);
  });
});

// Keep the module-level warning quiet in this file.
vi.spyOn(console, "warn").mockImplementation(() => undefined);
