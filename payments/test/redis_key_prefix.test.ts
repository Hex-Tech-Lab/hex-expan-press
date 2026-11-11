import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL, loadRedisSection } from "../src/settings_registry";

// The Redis key prefix namespaces every key the app writes. An empty or unnamespaced value must never load.
describe("settings registry: redis.key_prefix", () => {
  it("defaults to the namespace the shared client has always used", () => {
    expect(DEFAULT_GLOBAL.redis.key_prefix).toBe("expan:");
    expect(loadRedisSection(undefined)).toEqual({ key_prefix: "expan:" });
  });

  it("accepts a namespaced prefix", () => {
    expect(loadRedisSection({ key_prefix: "staging:" })).toEqual({ key_prefix: "staging:" });
  });

  it.each([["empty", ""], ["no colon", "expan"], ["bare colon", ":"], ["non-string", 42]])(
    "refuses a %s prefix",
    (_label, value) => {
      expect(() => loadRedisSection({ key_prefix: value })).toThrow(/key_prefix must be a non-empty string ending in ":"/);
    },
  );
});
