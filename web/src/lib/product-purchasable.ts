/**
 * Price and purchasability rules for buyer surfaces.
 *
 * isPurchasableProduct is the single buy-form rule: live AND priced AND at least one usable active rail. A product with
 * no usable rail is "Coming soon" on the product page, the checkout page and the storefront cards, never an error page.
 * The usable rail count comes from resolveCheckoutRails (web/src/lib/checkout-rails.ts), which the checkout route also
 * uses, so the buyer and the route always agree. The checkout route shares only productPriceUsd: it fails closed with
 * 409 on a null price, and its own launch gate (live, or sandbox when allowed) still decides the rest.
 * A null (or blank, or non-numeric) price_usd means "not for sale yet".
 * Pure function, no imports, so server routes and React components can both use it.
 */

/** Numeric-as-string coercion with a finite guard (Sprint 15 money-path rule). Null means no usable price. */
export function productPriceUsd(raw: unknown): number | null {
  if (typeof raw === "string" && raw.trim() === "") return null;
  // Type-narrow before coercing: Number(null) is 0 and Number(true) is 1, so only strings and numbers convert.
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Buy form only for a live, priced product with at least one usable active rail (0 rails is "Coming soon"). */
export function isPurchasableProduct(
  product: { checkout_mode?: string | null; price_usd?: unknown },
  usableRailCount: number,
): boolean {
  return product.checkout_mode === "live" && productPriceUsd(product.price_usd) !== null && usableRailCount >= 1;
}
