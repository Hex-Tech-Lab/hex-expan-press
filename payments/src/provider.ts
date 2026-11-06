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
  // ISO 4217, uppercase, already checked against the allowed-currency gate. Optional only for
  // providers outside the legacy wrapper; the wrapper refuses a sale without it.
  currency?: string;
  ts: string; // ISO-8601, provider event time when available
  email_hash: string; // sha256 hex of lowercased/trimmed buyer email — never store raw email
  // Transient, for the receipt and download-link email only. Never persisted; the ledger keeps email_hash.
  buyer_email?: string;
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
  // provider cannot report the refunded amount; the engine routes it to manual review
  amount_unverifiable?: true;
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

// Attribution labels are buyer-controlled (set client-side at checkout), so the
// webhook keeps only the canonical <src>[:<dub_id>] shape the storefront emits
// (web/src/lib/attribution.ts) and drops anything else — never rejects: a bad
// label must not cost a paid sale.
const ATTRIBUTION_ID_RE = /^[A-Za-z0-9_.-]{1,64}(:[A-Za-z0-9_.-]{1,64})?$/;

export function cleanAttributionId(raw: unknown): string | undefined {
  return typeof raw === "string" && ATTRIBUTION_ID_RE.test(raw) ? raw : undefined;
}

// Optional minus, digits, optional fraction. No sign "+", no exponent, no hex/binary/octal
// prefix, no thousands separator, no surrounding whitespace.
const PLAIN_DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * A raw provider amount as a finite number, or undefined when it is absent, null, blank,
 * non-numeric or not a number/string. A string must be a plain decimal: Number() would read
 * "0x10" as 16 and "1e3" as 1000. Never coerces null or "" to 0 (a $0 sale) and never
 * yields NaN (which slips past `<`/`!==` amount guards).
 */
export function strictAmount(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string" && PLAIN_DECIMAL_RE.test(raw)) return Number(raw);
  return undefined;
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
