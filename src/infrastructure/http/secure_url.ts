/**
 * One transport policy for credential-bearing URLs: https, or http to a listed loopback host. Shared by the Supabase
 * seam (payments/src/supabase_admin.ts) and the Redis client. The loopback list is passed in because the callers differ:
 * the Supabase guard accepts [::1] for local development, and the Redis client does not.
 *
 * Named assertSecure* so the credential-send rule (qa-intel credential-send-before-guard) recognises it as a guard.
 * The refusal error is built by the caller, so each caller keeps its own message.
 */
export function assertSecureTransport(url: URL, loopbackHosts: readonly string[], refuse: (protocol: string) => Error): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && loopbackHosts.includes(url.hostname)) return;
  throw refuse(url.protocol);
}
