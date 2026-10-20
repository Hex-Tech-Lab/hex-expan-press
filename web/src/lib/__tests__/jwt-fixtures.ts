// Shared JWT fixtures for auth regression tests (proxy.test.ts, supabase-server.test.ts).
// Test-only HMAC secret: a dummy value, never a real Supabase JWT secret.
import { createHmac } from "node:crypto";

export const MOCK_HMAC_KEY = "dummy-testing-only-hmac-fixture-string";

export function makeTestJwt(
  payload: Record<string, unknown>,
  options: { secret?: string; alg?: string; rawSignature?: string } = {},
): string {
  const alg = options.alg ?? "HS256";
  const secret = options.secret ?? MOCK_HMAC_KEY;
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  let sig: string;
  if (options.rawSignature !== undefined) {
    sig = options.rawSignature;
  } else if (alg === "none") {
    sig = "";
  } else {
    sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  }
  return `${header}.${body}.${sig}`;
}
