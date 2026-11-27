/**
 * Price and purchasability rules for buyer surfaces.
 *
 * isPurchasableProduct is the single buy-form rule: live AND priced AND at least one usable active rail. A product with
 * no usable rail is "Coming soon" on the product page, the checkout page and the storefront cards, never an error page.
 * The usable rail count comes from resolveCheckoutRails (web/src/lib/checkout-rails.ts), which the checkout route also
 * uses, so the buyer and the route always agree. The checkout route also shares productPriceUsd: it fails closed with
 * 409 on a null price. Its own launch gate (live, or sandbox when allowed) still decides the rest.
 * A null (or blank, or non-numeric) price_usd means "not for sale yet".
 * Pure function, no imports, so server routes and React components can both use it.
 */

/**
 * A plain decimal: digits with an optional fraction ("39", "39.00", ".5"). Hex ("0x10"), exponent ("1e3"), signs, separators and
 * words are refused, because Number() reads them as values a buyer never typed.
 */
const PLAIN_DECIMAL = /^(?:\d+\.?\d*|\.\d+)$/;

/**
 * Money-path price rule (Sprint 15). Accepts only a finite, strictly positive plain decimal, matching the prod DB CHECK
 * (price_usd IS NULL OR price_usd > 0). Null means "not for sale yet": no price, zero, negative, NaN, Infinity, or non-decimal.
 */
export function productPriceUsd(raw: unknown): number | null {
  // Type-narrow before coercing: only strings and finite numbers are candidates; null, booleans and objects are refused.
  let text: string;
  if (typeof raw === "string") text = raw.trim();
  else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
  else return null;
  if (!PLAIN_DECIMAL.test(text)) return null;
  const n = typeof text === "string" ? Number(text) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The launch gate every buyer surface and the checkout route share: a live product is open; a sandbox product is open only when
 * sandboxAllowed is true. Pages, storefront cards and isPurchasableProduct all read this, so they cannot disagree.
 */
export function isLaunchOpen(product: { checkout_mode?: string | null }, sandboxAllowed = false): boolean {
  return product.checkout_mode === "live" || (product.checkout_mode === "sandbox" && sandboxAllowed);
}

/**
 * Buy form only for a priced product with at least one usable active rail (0 rails is "Coming soon"). The launch gate is
 * isLaunchOpen; the route applies the same rule.
 */
export function isPurchasableProduct(
  product: { checkout_mode?: string | null; price_usd?: unknown },
  usableRailCount: number,
  sandboxAllowed = false,
): boolean {
  return isLaunchOpen(product, sandboxAllowed) && productPriceUsd(product.price_usd) !== null && usableRailCount >= 1;
}
