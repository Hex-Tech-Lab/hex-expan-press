// Shared HMAC signers for the billing webhook route tests. Test-only: every key is
// passed in by the calling test file, so no secret lives in this module.
import crypto from "node:crypto";

/** Current unix time in whole seconds, as the Standard Webhooks timestamp header expects. */
export const nowTimestamp = (): string => Math.floor(Date.now() / 1000).toString();

/** Standard Webhooks signature value: `v1,<base64 HMAC-SHA256 over "${id}.${ts}.${payload}">`. */
export function standardWebhookSignature(key: string, id: string, ts: string, payload: string): string {
  const sig = crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(`${id}.${ts}.${payload}`).digest("base64");
  return `v1,${sig}`;
}

/** Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature), as a Polar delivery sends them. */
export function standardWebhookHeaders(key: string, id: string, payload: string, ts: string = nowTimestamp()) {
  return {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": standardWebhookSignature(key, id, ts, payload),
  };
}

/** Fungies x-fngs-signature value: `sha256_<hex HMAC-SHA256 over the raw body>`. */
export function fungiesSignatureHeader(key: string, payload: string): string {
  const sig = crypto.createHmac("sha256", key).update(Buffer.from(payload, "utf8")).digest("hex");
  return `sha256_${sig}`;
}
