/**
 * The one rail resolver for buyer-facing checkout (KYC P1, mor-label-shared-resolver).
 *
 * Both web/app/api/billing/checkout/route.ts (the MatrixRouter path) and the checkout and product pages read the same
 * product_rails rows through this module, so the merchant of record the buyer sees is the rail the route can actually
 * use. A rail counts only when it is active, its provider is switched on in the registry, and a webhook verifier exists
 * for that provider (verifiedProviderNames). Pure: no I/O, no imports beyond the purchasability rule.
 */
import { isPurchasableProduct } from "./product-purchasable";

/** One product_rails row as read from Supabase. Fields are unknown until validated here. */
export interface RailRowInput {
  provider: unknown;
  weight: unknown;
  checkout_url?: unknown;
  active: unknown;
}

/** An active, enabled, verified rail the route may send a buyer to. */
export interface UsableRail {
  provider: string;
  weight: number;
  checkout_url: string;
}

/**
 * malformed: a row is not an object, or an active row has a missing provider, a non-string checkout_url, or a bad weight.
 * The route answers 500 "Checkout is not configured"; the page treats it as zero usable rails (no buy form).
 */
export type RailResolution =
  | { kind: "malformed"; reason: "non_object_row" | "invalid_active_row" }
  | { kind: "ok"; configuredCount: number; usable: UsableRail[] };

export interface RailPolicy {
  /** The registry switch: is this provider enabled (providers.json / inline defaults). */
  isEnabledProvider: (provider: string) => boolean;
  /** Providers that have a webhook verifier. A rail for any other provider cannot be verified, so it must not take a buyer. */
  verifiedProviders: ReadonlySet<string>;
}

/** Resolve product_rails rows in the order given (the query orders by weight, highest first). */
export function resolveCheckoutRails(rows: ReadonlyArray<unknown> | null | undefined, policy: RailPolicy): RailResolution {
  const list = rows ?? [];
  if (list.some((r) => r === null || typeof r !== "object")) return { kind: "malformed", reason: "non_object_row" };
  const usable: UsableRail[] = [];
  for (const raw of list) {
    const row = raw as RailRowInput;
    const active = row.active === true || row.active === "true";
    if (!active) continue;
    // Type-narrow before coercing: Number(null) is 0, which would turn a null weight into a valid rail. Anything but a
    // number or a numeric string is malformed (fails closed). The column is integer not null with weight > 0.
    const weight = typeof row.weight === "number" || typeof row.weight === "string" ? Number(row.weight) : Number.NaN;
    if (typeof row.provider !== "string" || row.provider === "" || typeof row.checkout_url !== "string" || !Number.isFinite(weight) || weight < 0) {
      return { kind: "malformed", reason: "invalid_active_row" };
    }
    if (policy.isEnabledProvider(row.provider) && policy.verifiedProviders.has(row.provider)) {
      usable.push({ provider: row.provider, weight, checkout_url: row.checkout_url });
    }
  }
  return { kind: "ok", configuredCount: list.length, usable };
}

/** Malformed rows count as zero usable rails for buyer surfaces: nothing malformed can take a buyer. */
export function usableRailsOf(resolution: RailResolution): UsableRail[] {
  return resolution.kind === "ok" ? resolution.usable : [];
}

/**
 * What a buyer surface shows for a product. purchasable: the buy form (the POST to /api/billing/checkout, or the overlay).
 * merchantOfRecordProvider: named only when exactly one usable rail exists, because then the route has no choice to make.
 * With two or more rails the buyer still gets the POST fallback, but no merchant of record and no overlay (narrow rule).
 */
export function checkoutRailView(
  product: { checkout_mode?: string | null; price_usd?: unknown },
  usable: ReadonlyArray<UsableRail>,
): { purchasable: boolean; merchantOfRecordProvider: string | null } {
  const purchasable = isPurchasableProduct(product, usable.length);
  const merchantOfRecordProvider = purchasable && usable.length === 1 ? usable[0]!.provider : null;
  return { purchasable, merchantOfRecordProvider };
}
