/**
 * One transport policy for credential-bearing URLs: https, or http to a listed loopback host. Shared by the Supabase
 * seam (payments/src/supabase_admin.ts) and the Redis client. The loopback list is passed in because the callers differ:
 * the Supabase guard accepts [::1] for local development, and the Redis client does not.
 *
 * transportRefusal returns the refused protocol, or undefined when the URL may carry a credential. Callers that must
 * throw use assertSecureTransport, named assertSecure* so the credential-send rule (qa-intel
 * credential-send-before-guard) recognises it as a guard. Callers that report instead (the launch gate) use
 * transportRefusal directly. Each caller builds its own message.
 */
export function transportRefusal(url: URL, loopbackHosts: readonly string[]): string | undefined {
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && loopbackHosts.includes(url.hostname)) return undefined;
  return url.protocol;
}

export function assertSecureTransport(url: URL, loopbackHosts: readonly string[], refuse: (protocol: string) => Error): void {
  const refused = transportRefusal(url, loopbackHosts);
  if (refused !== undefined) throw refuse(refused);
}
