/**
 * Price and purchasability rules for buyer surfaces.
 *
 * isPurchasableProduct (live AND priced) gates the product and checkout pages. The checkout route shares only
 * productPriceUsd: it fails closed with 409 on a null price, and its own launch gate (live, or sandbox when allowed)
 * still decides the rest. A null (or blank, or non-numeric) price_usd means "not for sale yet".
 * Pure function, no imports, so server routes and React components can both use it.
 */

/** Numeric-as-string coercion with a finite guard (Sprint 15 money-path rule). Null means no usable price. */
export function productPriceUsd(raw: unknown): number | null {
  if (typeof raw === "string" && raw.trim() === "") return null;
  // Type-narrow before coercing: Number(null) is 0 and Number(true) is 1, so only strings and numbers convert.
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function isPurchasableProduct(product: { checkout_mode?: string | null; price_usd?: unknown }): boolean {
  return product.checkout_mode === "live" && productPriceUsd(product.price_usd) !== null;
}
