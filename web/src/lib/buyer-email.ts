// Buyer email step, shown on the product page before provider checkout. Pure helpers with no settings-registry import, so the
// client component and the server routes share one rule. Callers pass the registry values in (domains, maxLength, timing).
import MailSpellChecker from "@zootools/email-spell-checker";
import { z } from "zod";

/**
 * A suggested correction for a probable domain typo (for example gmial.com to gmail.com). The caller shows it and the buyer
 * accepts it with one click. It is never applied silently: the typed address is what gets sent.
 */
export function suggestBuyerEmail(email: string, domains: readonly string[]): string | undefined {
  const trimmed = email.trim();
  if (trimmed === "" || domains.length === 0) return undefined;
  return MailSpellChecker.run({ email: trimmed, domains: [...domains] })?.full;
}

/** Shape and length check: zod's email rule, with the length ceiling from the registry (email_address.max_length). */
export function isValidBuyerEmail(email: string, maxLength: number): boolean {
  return z.email().max(maxLength).safeParse(email.trim()).success;
}

/** The confirm field must equal the email field after trimming. An empty pair never matches. */
export function buyerEmailsMatch(email: string, confirm: string): boolean {
  const first = email.trim();
  return first !== "" && first === confirm.trim();
}

export interface BuyerEmailState {
  valid: boolean;
  matches: boolean;
  /** A typo suggestion for the typed address, if the domain is a near miss. */
  suggestion: string | undefined;
  /** The buy button is enabled only when the address is valid and the confirm field matches it. */
  canBuy: boolean;
}

export function buyerEmailState(
  email: string,
  confirm: string,
  options: { domains: readonly string[]; maxLength: number },
): BuyerEmailState {
  const valid = isValidBuyerEmail(email, options.maxLength);
  const matches = buyerEmailsMatch(email, confirm);
  return { valid, matches, suggestion: suggestBuyerEmail(email, options.domains), canBuy: valid && matches };
}

/**
 * The consent line, verbatim, with the promise from the registry: the usual delay (delivery.buyer_typical_minutes), the hour
 * after which the buyer is sent to support (delivery.buyer_support_after_hours), and the support address (email.reply_to).
 * The wording is the founder's text and must not be reworded.
 */
export function buyerConsentText(typicalMinutes: number, supportAfterHours: number, supportEmail: string): string {
  const window = supportAfterHours === 1 ? "1 hour" : `${supportAfterHours} hours`;
  return `ExpanPress will email your e-book to this address, usually within ${typicalMinutes} minutes. If it has not arrived within ${window}, email ${supportEmail} and we will send it by hand. We may also email you about this purchase and related updates. You can unsubscribe at any time.`;
}

/**
 * Thank-you page delivery body, using the same registry timing and support address as buyerConsentText.
 */
export function buyerDeliveryPromiseText(typicalMinutes: number, supportAfterHours: number, supportEmail: string): string {
  const mins = typicalMinutes === 1 ? "1 minute" : `${typicalMinutes} minutes`;
  const window = supportAfterHours === 1 ? "1 hour" : `${supportAfterHours} hours`;
  return `Your e-book is on its way to the email you used at checkout, usually within ${mins}. If it has not arrived within ${window}, email ${supportEmail} and we will send it by hand.`;
}

/** Attribution parameters read from storage (with optional query-param fallback). The storage key for each parameter comes from ATTRIBUTION_KEYS (attribution.ts). */
export function storedAttributionParams(
  read: (storageKey: string, param: string) => string | null,
  keys: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [param, storageKey] of Object.entries(keys)) {
    const value = read(storageKey, param);
    if (value) out[param] = value;
  }
  return out;
}

/**
 * The checkout page URL for a buyer: the email and consent choice, plus any attribution. Attribution is forwarded as the
 * existing checkout page expects it. The email travels only in this query; it is not logged by this module.
 */
export function buyerCheckoutHref(
  checkoutBase: string,
  buyer: { email: string; consent: boolean },
  attribution: Record<string, string>,
): string {
  const url = new URL(checkoutBase);
  url.searchParams.set("buyer_email", buyer.email.trim());
  url.searchParams.set("buyer_consent", buyer.consent ? "true" : "false");
  for (const [param, value] of Object.entries(attribution)) {
    if (value) url.searchParams.set(param, value);
  }
  return url.toString();
}
