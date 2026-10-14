import { NextResponse } from "next/server";

/** Thrown when an audit write cannot happen because the Supabase infrastructure keys are
 *  absent. Fail-closed (ARTAS): a missing audit trail must surface as an error, never as a
 *  silent skip. Webhook POST handlers convert it with auditUnavailableResponse(); the provider
 *  then retries on the 500. */
export class AuditUnavailableError extends Error {
  constructor(missing: readonly string[]) {
    super(`audit trail unavailable: ${missing.join(", ")} not set`);
    this.name = "AuditUnavailableError";
  }
}

/** Boundary conversion for webhook POST handlers: an AuditUnavailableError becomes a fixed
 *  500 JSON body (no internals; the 503 Retry-After is intentionally dropped, the 5xx itself
 *  is the provider's retry signal). Any other error is rethrown unchanged. */
export function auditUnavailableResponse(err: unknown): NextResponse {
  if (!(err instanceof AuditUnavailableError)) throw err;
  console.error(`[audit] ${err.message}; answering 500 so the provider retries`);
  return NextResponse.json({ ok: false, error: "Internal Server Error" }, { status: 500 });
}

/** Returns the Supabase URL and secret key for an audit write, or throws AuditUnavailableError.
 *  The error names the missing variables only; it never includes a value. */
export function requireAuditSupabaseConfig(
  env: Record<string, string | undefined> = process.env,
): { url: string; key: string } {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_SECRET_KEY"].filter((v): v is string => Boolean(v));
  if (missing.length > 0 || !url || !key) throw new AuditUnavailableError(missing);
  return { url, key };
}
