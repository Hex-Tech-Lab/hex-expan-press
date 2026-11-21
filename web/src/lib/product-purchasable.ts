/**
 * Purchasability rule shared by the product page, the checkout page, and the checkout route.
 *
 * A product is purchasable only when it is live AND has a usable price. A null (or blank, or non-numeric) price_usd
 * means "not for sale yet": buyer surfaces show a non-purchasable state and the checkout route fails closed with 409.
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
