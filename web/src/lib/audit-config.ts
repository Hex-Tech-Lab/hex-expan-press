/** Thrown when an audit write cannot happen because the Supabase infrastructure keys are
 *  absent. Fail-closed (ARTAS): a missing audit trail must surface as an error, never as a
 *  silent skip. Callers must not catch it; the webhook then answers 500 and the provider retries. */
export class AuditUnavailableError extends Error {
  constructor(missing: readonly string[]) {
    super(`audit trail unavailable: ${missing.join(", ")} not set`);
    this.name = "AuditUnavailableError";
  }
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
