// Sibling test for settings_registry.ts (the contract auditor counts only a test beside its module). The usage-watch
// endpoint allowlist is the only set of hosts that may receive a Supabase or Upstash credential, so two invariants are
// pinned here: every allowlisted entry is a bare HTTPS origin, and the registry default for each provider is that origin.
import { describe, it, expect } from "vitest";
import { DEFAULT_GLOBAL, USAGE_WATCH_ENDPOINT_ORIGINS } from "./settings_registry.ts";

type EndpointKey = keyof typeof USAGE_WATCH_ENDPOINT_ORIGINS;
const ENDPOINT_KEYS = Object.keys(USAGE_WATCH_ENDPOINT_ORIGINS) as EndpointKey[];

describe("usage_watch endpoint allowlist", () => {
  it.each(ENDPOINT_KEYS)("%s is an https origin with no path, query, userinfo or trailing slash", (key) => {
    const origin = USAGE_WATCH_ENDPOINT_ORIGINS[key];
    expect(new URL(origin).origin).toBe(origin);
    expect(origin.startsWith("https://")).toBe(true);
  });

  it.each(ENDPOINT_KEYS)("the registry default for %s is its allowlisted origin", (key) => {
    expect(DEFAULT_GLOBAL.usage_watch.endpoints[key]).toBe(USAGE_WATCH_ENDPOINT_ORIGINS[key]);
  });
});
