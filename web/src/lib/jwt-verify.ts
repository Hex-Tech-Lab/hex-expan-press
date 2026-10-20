import { createHmac, timingSafeEqual } from "node:crypto";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Validates, cryptographically verifies HMAC-SHA256 signature, and decodes a Supabase JWT.
 *
 * Fail-Closed Rules:
 * 1. Requires exactly 3 non-empty base64url segments.
 * 2. Requires header.alg === "HS256" (explicitly rejects "none", RS256, or unexpected algs).
 * 3. Requires process.env.SUPABASE_JWT_SECRET to be configured and non-empty.
 *    If secret is unset or empty, returns null to force online authentication check.
 * 4. Computes HMAC-SHA256 over `${header}.${payload}` using the secret and compares against
 *    the signature segment using constant-time timingSafeEqual.
 * 5. Requires exp > now + 60s (at least 60s remaining before expiry).
 * 6. Requires sub to be a valid UUID.
 * 7. Requires aud to be "authenticated" (or an array containing "authenticated").
 */
export function decodeAndVerifyJwt(token: string): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  if (!BASE64URL_REGEX.test(parts[0]) || !BASE64URL_REGEX.test(parts[1]) || !BASE64URL_REGEX.test(parts[2])) {
    return null;
  }

  const secret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (!secret) {
    return null; // Fail closed: without the HMAC secret, cannot verify signature locally
  }

  try {
    // 1. Verify header algorithm is strictly HS256
    const headerStr = Buffer.from(parts[0], "base64url").toString("utf8");
    const header = JSON.parse(headerStr);
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    if (header.alg !== "HS256") {
      return null; // Explicitly reject "none" or any unexpected algorithm
    }

    // 2. Cryptographic signature verification (constant time)
    const expectedSig = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    const actualSig = Buffer.from(parts[2], "base64url");
    if (expectedSig.length !== actualSig.length) {
      return null;
    }
    if (!timingSafeEqual(expectedSig, actualSig)) {
      return null;
    }

    // 3. Parse and validate payload claims
    const jsonStr = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(jsonStr);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp - now <= 60) {
      return null;
    }
    if (typeof payload.sub !== "string" || !UUID_REGEX.test(payload.sub)) return null;

    const aud = payload.aud;
    const isValidAud = aud === "authenticated" || (Array.isArray(aud) && aud.includes("authenticated"));
    if (!isValidAud) return null;

    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}
