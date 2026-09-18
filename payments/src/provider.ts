// provider.ts — provider-agnostic checkout/webhook adapter interface for the payments layer.
// MOR (merchant of record) handles tax/VAT. For manual-payout providers (Lemon Squeezy, Payhip)
// our only job on a webhook is: verify -> parse -> append sale record.
import type { IncomingHttpHeaders } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type ProviderName = "lemonsqueezy" | "payhip" | "paddle" | "polar" | "fungies" | "fastspring";

export interface SaleEvent {
  sale_id: string;
  provider: ProviderName;
  product_id: string;
  amount_usd: number;
  ts: string; // ISO-8601, provider event time when available
  email_hash: string; // sha256 hex of lowercased/trimmed buyer email — never store raw email
  // Our own canonical cross-provider attribution ID (added 2026-09-18) — generated client-side
  // (payments/bake_checkout.ts's attribution-capture script), NOT provider-owned. Threaded
  // through whichever custom-data/metadata mechanism each provider supports, extracted back out
  // in that provider's parseWebhook. This is what makes attribution joinable across a
  // multi-provider cascade (Polar today; Paddle/LemonSqueezy/Fungies field_map entries added,
  // client-side checkout-link wiring for those three NOT yet built — see
  // data/intel/canonical_attribution_id_2026-09-18.md). Optional: absent on providers where no
  // passthrough mechanism is wired yet, or on direct/organic sales with no captured source.
  attribution_id?: string;
}

export interface RefundEvent {
  provider: ProviderName;
  sale_id: string;
  ts: string;
}

export type ParseResult =
  | { ok: true; sale: SaleEvent }
  | { ok: true; refund: RefundEvent }
  | { ok: true; batch: ({ sale: SaleEvent } | { refund: RefundEvent })[] }
  | { ok: false; status: number; error: string };

export interface CheckoutProvider {
  name: ProviderName;
  /**
   * Verify the webhook signature, then parse the raw body into a SaleEvent.
   * MUST read only the raw bytes (Buffer) for signature computation — never a re-serialized object.
   * Returns a rejected ParseResult (with an HTTP status to reply) on anything that must not be recorded.
   */
  parseWebhook(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string | undefined): ParseResult;
}

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function hmacSha256Hex(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time compare of two hex digests; safe against length leaks. */
export function safeEqualHex(expectedHex: string, gotHex: string): boolean {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(gotHex, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
