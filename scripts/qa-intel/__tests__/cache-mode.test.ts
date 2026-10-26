import { describe, expect, test } from "vitest";
import { QA_INTEL_CONFIG } from "../config";
import { resolveCacheMode } from "../cache-mode";

describe("resolveCacheMode", () => {
  test("memory when Redis was not requested, whatever the environment", () => {
    expect(resolveCacheMode({ requested: false, ci: false, redisConfigured: true })).toEqual({ kind: "memory", reason: "not-requested" });
  });

  test("memory with reason ci when requested under CI (printed by the caller, not silent)", () => {
    expect(resolveCacheMode({ requested: true, ci: true, redisConfigured: true })).toEqual({ kind: "memory", reason: "ci" });
  });

  test("redis when requested, configured, and not CI", () => {
    expect(resolveCacheMode({ requested: true, ci: false, redisConfigured: true })).toEqual({ kind: "redis" });
  });

  test("throws, naming the env vars, when requested without credentials (no silent fallback)", () => {
    const expected = `${QA_INTEL_CONFIG.redisEnvVars.join(" and ")} set`;
    expect(() => resolveCacheMode({ requested: true, ci: false, redisConfigured: false })).toThrow(expected);
    expect(() => resolveCacheMode({ requested: true, ci: false, redisConfigured: false })).toThrow("Refusing to fall back");
  });
});
