// Branch coverage for web/src/lib/paddle-env.ts — every resolution branch,
// including the sandbox-in-production fail-closed rule and blank-token nulls.
import { describe, it, expect, vi, afterEach } from "vitest";
import { paddleClientToken, resolvePaddleEnvironment } from "../paddle-env";

describe("resolvePaddleEnvironment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each<[string, string | undefined]>([
    ["undefined (not set)", undefined],
    ["empty string", ""],
    ["wrong case", "Sandbox"],
    ["unknown value", "staging"],
  ])("raw = %s → ok:false (must be exactly sandbox or production)", (_label, raw) => {
    const res = resolvePaddleEnvironment(raw, "preview");
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.reason).toBe("NEXT_PUBLIC_PADDLE_ENVIRONMENT must be sandbox or production");
  });

  it("raw=sandbox with vercelEnv=production → ok:false (sandbox Paddle is not allowed in production)", () => {
    const res = resolvePaddleEnvironment("sandbox", "production");
    expect(res.ok).toBe(false);
    expect(res.ok ? null : res.reason).toBe("sandbox Paddle is not allowed in production");
  });

  it("raw=production with vercelEnv=production → ok:true production", () => {
    const res = resolvePaddleEnvironment("production", "production");
    expect(res).toEqual({ ok: true, env: "production" });
  });

  it("raw=sandbox with vercelEnv=preview → ok:true sandbox", () => {
    expect(resolvePaddleEnvironment("sandbox", "preview")).toEqual({ ok: true, env: "sandbox" });
  });

  it("raw=sandbox with vercelEnv undefined (non-Vercel dev) → ok:true sandbox", () => {
    expect(resolvePaddleEnvironment("sandbox", undefined)).toEqual({ ok: true, env: "sandbox" });
  });

  it("raw=production with vercelEnv undefined → ok:true production", () => {
    expect(resolvePaddleEnvironment("production", undefined)).toEqual({ ok: true, env: "production" });
  });

  it("default args read the NEXT_PUBLIC_* env vars", () => {
    vi.stubEnv("NEXT_PUBLIC_PADDLE_ENVIRONMENT", "sandbox");
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    expect(resolvePaddleEnvironment()).toEqual({ ok: false, reason: "sandbox Paddle is not allowed in production" });

    vi.stubEnv("NEXT_PUBLIC_PADDLE_ENVIRONMENT", "production");
    expect(resolvePaddleEnvironment()).toEqual({ ok: true, env: "production" });
  });
});

describe("paddleClientToken", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "");
    expect(paddleClientToken()).toBeNull();
  });

  it("returns null when empty or whitespace-only", () => {
    vi.stubEnv("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "");
    expect(paddleClientToken()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "   ");
    expect(paddleClientToken()).toBeNull();
  });

  it("returns the trimmed token", () => {
    vi.stubEnv("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", "  tok_123  ");
    expect(paddleClientToken()).toBe("tok_123");
  });

  it("refuses sandbox on a production build with no Vercel signal (fail closed)", () => {
    expect(resolvePaddleEnvironment("sandbox", undefined, "production")).toEqual({ ok: false, reason: "sandbox Paddle is not allowed in production" });
    expect(resolvePaddleEnvironment("sandbox", "staging", "development").ok).toBe(false);
    expect(resolvePaddleEnvironment("sandbox", undefined, "development")).toEqual({ ok: true, env: "sandbox" });
  });
});
