/**
 * Paddle env resolution — fail-closed mirror of the checkout sandbox policy.
 * Paddle must be pinned to an explicit environment name, and sandbox needs a
 * POSITIVE non-production signal: NEXT_PUBLIC_VERCEL_ENV preview/development,
 * or (no Vercel signal) NODE_ENV development/test. An absent or unknown signal
 * on a production build refuses sandbox.
 */

export type PaddleEnvironment = "sandbox" | "production";

export type PaddleEnvironmentResolution =
  | { ok: true; env: PaddleEnvironment }
  | { ok: false; reason: string };

export function resolvePaddleEnvironment(
  raw: string | undefined = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT,
  vercelEnv: string | undefined = process.env.NEXT_PUBLIC_VERCEL_ENV,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): PaddleEnvironmentResolution {
  if (raw !== "sandbox" && raw !== "production") {
    return { ok: false, reason: "NEXT_PUBLIC_PADDLE_ENVIRONMENT must be sandbox or production" };
  }
  if (raw === "sandbox") {
    const sandboxAllowed = vercelEnv
      ? vercelEnv === "preview" || vercelEnv === "development"
      : nodeEnv === "development" || nodeEnv === "test";
    if (!sandboxAllowed) return { ok: false, reason: "sandbox Paddle is not allowed in production" };
  }
  return { ok: true, env: raw };
}

export function paddleClientToken(): string | null {
  const raw = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
