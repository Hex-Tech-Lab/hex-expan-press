import { cache } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { notFound } from "next/navigation";
import "server-only";
import { getSupabaseAdmin } from "../../../../payments/src/supabase_admin";
import { GLOBAL, isEnabledPaymentProvider } from "../../../../payments/src/settings_registry";
import { guidSchema, productSlugSchema } from "../../lib/zod-rules";
import { resolveProductBookAssets } from "../../lib/book-assets";
import { isHouseCreator } from "../../lib/house";
import { isPurchasableProduct, productPriceUsd } from "../../lib/product-purchasable";
import { resolveCheckoutRails, usableRailsOf, type RailResolution, type UsableRail } from "../../lib/checkout-rails";
import { verifiedProviderNames } from "../../../app/api/billing/webhook/verifiers";
import { checkoutUrlProblem } from "../../../app/api/billing/checkout/checkout-helpers";
import { BrandFooter } from "../brand/brand";

/**
 * Storefront SSR (Sprint 16 — the dynamic handoff).
 *
 * Replaces the frozen static buyer pages: the baked HTML under public/c/ was
 * generated at bake time from the DB, so prices, product lists, and checkout
 * status drifted from the Postgres SSOT the moment commercial state changed
 * (the deployed artifact still said "Checkout coming online" while the
 * checkout route was live). These components render the same design directly
 * from Supabase with `revalidate = 60` — at most one minute of drift, and the
 * checkout route itself stays the live money-path authority regardless.
 *
 * Data access: `getSupabaseAdmin()` — the checkout route's established
 * server-side seam. The anon RLS policies on creators/products are
 * authenticated-only, so the publishable client would read an empty set;
 * these pages render public marketing content (profile, title, price, description)
 * and read product_rails only to count usable rails and name the single rail's provider.
 * Rail rows and checkout URLs never reach the rendered output. The checkout page renders the single usable rail's
 * provider key (a hidden `rail` field) and its display name as the merchant of record.
 *
 * On a transient DB failure during ISR revalidation Next serves the last good
 * page (stale-while-error) — availability for a marketing surface, while the
 * money path (checkout route) always fails closed live.
 */

export interface StoreProduct {
  id: string;
  store_product_id: string | null;
  slug: string | null;
  title: string | null;
  /** PostgREST returns numeric columns as strings — always coerce. */
  price_usd: string | number | null;
  currency: string | null;
  working_note: string | null;
  description: string | null;
  disclaimers: string[] | null;
  /** "What's inside" bullets; malformed entries are skipped at render. */
  inside: unknown;
  /** Only 'live' sells (the launch trigger guards that transition). */
  checkout_mode: string | null;
  /** Paddle price id used by the pay.expanpress.com Paddle.js overlay (products.paddle_price_id). */
  paddle_price_id?: string | null;
  /** Existing DB pointer to books/<id>.json; resolves cover_image, preview_pdf, is_sample without a DB migration. */
  book_registry?: string | null;
  cover_image?: string | null;
  preview_pdf?: string | null;
  preview_audio_manifest?: string | null;
  is_sample?: boolean;
  overview?: string | null;
  /** Usable rail count from the shared resolver (checkout-rails.ts). Buyer purchasability needs at least one. */
  usable_rail_count?: number;
}

export interface HubCreator {
  handle: string;
  display_name: string;
  platform_handles: Record<string, string> | null;
  bio: string | null;
  photo: string | null;
  /** Operator-set house flag (creators.is_house). Client roles cannot write it (creators_is_house_guard). */
  is_house: boolean;
  products: StoreProduct[];
}

/** Product slug shape comes from the settings registry (product_slug section, ADR 0065). Same rule as the DB CHECK. */

/** The product slug in storefront URLs is products.slug, the agreed rule (ADR 0065, DB CHECK).
 * A product is identified by its creator handle and products.slug only; no stored derived
 * identifier is read. Every product link and the product lookup go through this one function. */
export function productSlugOf(storeProduct: Pick<StoreProduct, "slug">): string {
  return storeProduct.slug ?? "";
}

/** numeric-as-string coercion with a finite guard (Sprint 15 money-path rule). Shared rule: lib/product-purchasable. */
export function priceOf(storeProduct: Pick<StoreProduct, "price_usd">): number | null {
  return productPriceUsd(storeProduct.price_usd);
}

/** Usable rails for a product's product_rails rows: the shared resolver with the route's verified-provider filter.
 *  Malformed rows yield no usable rails, so nothing malformed can take a buyer. */
// The verifier set is fixed by the code and the registry, so it is built once per process, not once per product row.
let verifiedNamesCache: ReadonlySet<string> | undefined;
export function resolveRailsForRows(rows: ReadonlyArray<unknown> | null | undefined, checkoutMode?: string | null): RailResolution {
  verifiedNamesCache ??= verifiedProviderNames();
  const resolution = resolveCheckoutRails(rows, {
    isEnabledProvider: isEnabledPaymentProvider,
    verifiedProviders: verifiedNamesCache,
    checkoutMode,
    checkoutUrlProblem,
  });
  // A malformed rail set is shown as Coming soon, but never silently: the reason is logged for operators.
  if (resolution.kind === "malformed") {
    console.error(`[storefront] product_rails malformed (${resolution.reason}) — product shown as Coming soon`);
    Sentry.captureException(new Error(`product_rails malformed: ${resolution.reason}`), { tags: { surface: "storefront_rails", reason: resolution.reason } });
  }
  return resolution;
}

export function usableRailsForRows(rows: ReadonlyArray<unknown> | null | undefined, checkoutMode?: string | null): UsableRail[] {
  return usableRailsOf(resolveRailsForRows(rows, checkoutMode));
}

/** Replaces the embedded product_rails rows with usable_rail_count, so the rail rows never reach a card or a page. */
function withRailCount<T extends object>(row: T & { product_rails?: unknown }): T & { usable_rail_count: number } {
  const { product_rails: railRows, ...rest } = row;
  const mode = (row as { checkout_mode?: string | null }).checkout_mode;
  if (!Array.isArray(railRows)) {
    console.error("[storefront] product_rails embed missing or not an array — product shown as Coming soon");
  }
  return { ...rest, usable_rail_count: usableRailsForRows(Array.isArray(railRows) ? railRows : [], mode).length } as T & {
    usable_rail_count: number;
  };
}

/**
 * Formats a product price and ISO currency code from the product row (falling back to `GLOBAL.defaults.currency`).
 * Replaces hard-coded `$${price.toFixed(2)}` and `"USD · one-time"` literals on buyer surfaces.
 */
export function formatProductPrice(
  price: number | null,
  currency?: string | null,
  emptyLabel: string = "-",
): { formatted: string; currency: string } {
  const code = (typeof currency === "string" && currency.trim() !== "" ? currency.trim() : GLOBAL.defaults.currency).toUpperCase();
  if (price === null) return { formatted: emptyLabel, currency: code };
  try {
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(price);
    return { formatted, currency: code };
  } catch (err) {
    console.error("[storefront] currency format fallback", {
      currency: code,
      error: err instanceof Error ? err.message : String(err),
    });
    return { formatted: `${code} ${price.toFixed(2)}`, currency: code };
  }
}

export function isWorkingTitle(storeProduct: StoreProduct): boolean {
  return typeof storeProduct.working_note === "string" && storeProduct.working_note.toUpperCase().startsWith("WORKING");
}

/** Only commercial products (store_product_id) belong on a storefront. */
export function commercialProducts<T extends { store_product_id: string | null }>(products: T[] | null | undefined): T[] {
  return (products ?? []).filter((storeProduct) => typeof storeProduct.store_product_id === "string" && storeProduct.store_product_id !== "");
}

async function fetchSiteOrigin(supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>): Promise<string> {
  const { data, error } = await supabase.from("system_config").select("value").eq("key", "site.origin").maybeSingle();
  if (error) throw new Error(`storefront: site.origin lookup failed: ${error.message}`);
  const origin = String((data as { value?: unknown } | null)?.value ?? "https://expanpress.com").replace(/\/$/, "");
  return origin;
}

function withResolvedAssets<T extends { id?: string | null; slug: string | null; title: string | null; book_registry?: string | null }>(
  storeProduct: T,
  creatorIsHouse: boolean | null | undefined,
): T & {
  book_registry: string | null;
  cover_image: string | null;
  preview_pdf: string | null;
  preview_audio_manifest: string | null;
  is_sample: boolean;
  overview: string | null;
} {
  const assets = resolveProductBookAssets({ ...storeProduct, creator_is_house: creatorIsHouse });
  return {
    ...storeProduct,
    book_registry: assets.book_registry,
    cover_image: assets.cover_image,
    preview_pdf: assets.preview_pdf,
    preview_audio_manifest: assets.preview_audio_manifest,
    is_sample: assets.is_sample,
    overview: assets.overview,
  };
}

/** Storefront checkout modes queried on /books: always "live", plus registry-allowed non-live modes when sample listing is enabled. */
export function allowedStorefrontCheckoutModes(
  storefront: Pick<typeof GLOBAL.storefront, "show_non_live_samples" | "allowed_non_live_sample_modes"> = GLOBAL.storefront,
): string[] {
  if (!storefront.show_non_live_samples || storefront.allowed_non_live_sample_modes.length === 0) {
    return ["live"];
  }
  return Array.from(new Set(["live", ...storefront.allowed_non_live_sample_modes]));
}

/** Shared storefront shelf visibility rule for /books and /books/[handle]: live products are always listed;
 *  non-live products appear ONLY when storefront.show_non_live_samples is enabled, checkout_mode is in
 *  allowed_non_live_sample_modes, AND book_registry marks is_sample === true. Non-sample gated books stay hidden. */
export function isVisibleStorefrontProduct(
  product: Pick<StoreProduct, "checkout_mode" | "is_sample">,
  storefront: Pick<typeof GLOBAL.storefront, "show_non_live_samples" | "allowed_non_live_sample_modes"> = GLOBAL.storefront,
): boolean {
  if (product.checkout_mode === "live") return true;
  return (
    storefront.show_non_live_samples === true &&
    product.is_sample === true &&
    typeof product.checkout_mode === "string" &&
    storefront.allowed_non_live_sample_modes.includes(product.checkout_mode)
  );
}

/** A creator hub is published when it is the house hub, or when at least one product passes isVisibleStorefrontProduct
 *  (the same rule the shelf and /books use). Under storefront.hide_empty_creator_hubs (default true), a hub with nothing
 *  visible is 404 Not Found instead of an empty shelf that exposes the creator's name. false restores the empty shelf. */
export function isPublishedCreatorHub(hub: { creator: Pick<HubCreator, "is_house" | "products"> }): boolean {
  if (!GLOBAL.storefront.hide_empty_creator_hubs) return true;
  if (isHouseCreator(hub.creator)) return true;
  return hub.creator.products.some((storeProduct) => isVisibleStorefrontProduct(storeProduct));
}

// cache(): generateMetadata and the page share one query set per request.
export const fetchCreatorHub = cache(async function fetchCreatorHub(handle: string): Promise<{ creator: HubCreator; origin: string } | null> {
  if (!handle) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — hub cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("creators")
    .select(
      "handle, display_name, platform_handles, bio, photo, is_house, products(id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside, book_registry, product_rails(provider, weight, checkout_url, active))",
    )
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw new Error(`storefront: creator hub query failed for '${handle}': ${error.message}`);
  const creator = data as HubCreator | null;
  const commercial = commercialProducts(creator?.products);
  if (!creator || commercial.length === 0) return null;
  const origin = await fetchSiteOrigin(supabase);
  // Keep creator hubs consistent with /books: live products plus allowed non-live SAMPLE products only.
  // storefrontRobots depends only on whether a live product exists, so its result stays NOINDEX for sample-only hubs.
  const products = commercial
    .map((storeProduct) => withResolvedAssets(withRailCount(storeProduct), creator.is_house))
    .filter((storeProduct) => isVisibleStorefrontProduct(storeProduct));
  return { creator: { ...creator, products }, origin };
});

/** The fields /books renders (price, title, link, cover). No heavy detail columns are transferred for the landing. */
export type LandingProduct = Pick<
  StoreProduct,
  "id" | "store_product_id" | "slug" | "title" | "price_usd" | "checkout_mode" | "book_registry" | "cover_image" | "is_sample" | "usable_rail_count"
>;
export interface LandingCreator {
  handle: string;
  display_name: string;
  is_house?: boolean | null;
  products: LandingProduct[];
}

/** B2C landing (/books): every creator with at least one live or allowed non-live SAMPLE commercial product.
 * The filter runs in PostgREST (`!inner`) and JS enforces `isVisibleStorefrontProduct` after resolving `is_sample`
 * from `books/*.json`, ensuring non-sample gated books stay hidden. */
export const fetchB2cLanding = cache(async function fetchB2cLanding(): Promise<LandingCreator[]> {
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — B2C landing cannot render (fail closed)");
  }
  const modes = allowedStorefrontCheckoutModes();
  const baseQuery = supabase
    .from("creators")
    .select(
      "handle, display_name, is_house, products!inner(id, store_product_id, slug, title, price_usd, checkout_mode, book_registry, product_rails(provider, weight, checkout_url, active))",
    );
  const filteredQuery =
    modes.length === 1
      ? baseQuery.eq("products.checkout_mode", modes[0])
      : baseQuery.in("products.checkout_mode", modes);
  const { data, error } = await filteredQuery
    .not("products.store_product_id", "is", null)
    .neq("products.store_product_id", "");
  if (error) throw new Error(`storefront: B2C landing query failed: ${error.message}`);
  const rows = (data ?? []) as LandingCreator[];
  return rows
    .map((c) => ({
      ...c,
      products: commercialProducts(c.products)
        .map((storeProduct) => withResolvedAssets(withRailCount(storeProduct), c.is_house))
        .filter((storeProduct) => isVisibleStorefrontProduct(storeProduct)),
    }))
    .filter((c) => c.products.length > 0);
});

export const fetchStoreProduct = cache(async function fetchStoreProduct(
  handle: string,
  productSlug: string,
): Promise<{ creator: HubCreator; product: StoreProduct; origin: string } | null> {
  if (!handle || !productSlugSchema.safeParse(productSlug).success) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — product page cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("creators")
    .select(
      "handle, display_name, platform_handles, bio, photo, is_house, products(id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside, book_registry, product_rails(provider, weight, checkout_url, active))",
    )
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw new Error(`storefront: product page query failed for '${handle}/${productSlug}': ${error.message}`);
  const creator = data as HubCreator | null;
  if (!creator) return null;
  const product = commercialProducts(creator.products).find((storeProduct) => productSlugOf(storeProduct) === productSlug);
  if (!product) return null;
  const origin = await fetchSiteOrigin(supabase);
  return { creator, product: withResolvedAssets(withRailCount(product), creator.is_house), origin };
});

/** The single provider-agnostic checkout origin (ADR 0061). Buy links and the checkout page live here. */
export const PAY_ORIGIN = "https://pay.expanpress.com";


/** Checkout page lookup by product UUID (ADR 0061). Commercial products only, same rule as the storefront. */
export const fetchCheckoutProduct = cache(async function fetchCheckoutProduct(
  productId: string,
): Promise<{
  creator: { handle: string; display_name: string; is_house: boolean };
  product: StoreProduct;
  /** Usable rails in weight order, from the shared resolver. The page derives purchasable, MoR and overlay from these. */
  usableRails: UsableRail[];
  /** Active rails whose provider is switched on (malformed sets count 0; they report on their own). Switched-off rails are not counted. Zero is a designed state; more than zero with no usable rail is an outage. */
  activeRailCount: number;
  /** The shared resolver's verdict. "malformed" was already reported once by resolveRailsForRows (storefront_rails), so the page must not report it again. */
  railKind: RailResolution["kind"];
} | null> {
  if (!guidSchema.safeParse(productId).success) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — checkout page cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, paddle_price_id, inside, creators(handle, display_name, is_house)",
    )
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(`storefront: checkout product query failed for '${productId}': ${error.message}`);
  if (!data) return null;
  const row = data as unknown as StoreProduct & {
    creators: { handle: string; display_name: string; is_house: boolean } | Array<{ handle: string; display_name: string; is_house: boolean }> | null;
  };
  const creator = Array.isArray(row.creators) ? row.creators[0] : row.creators;
  if (!creator || commercialProducts([row]).length === 0) return null;
  const { data: railRows, error: railErr } = await supabase
    .from("product_rails")
    .select("provider, weight, checkout_url, active")
    .eq("product_id", productId)
    .order("weight", { ascending: false });
  if (railErr) throw new Error(`storefront: checkout rails query failed for '${productId}': ${railErr.message}`);
  // The same usable rails the checkout route counts (shared resolver). The first is the highest-weight usable rail (the page names it only when exactly one is usable); the count
  // drives the rail-aware rule: none is "Coming soon", more than one is no merchant of record and no overlay.
  const resolution = resolveRailsForRows(railRows, row.checkout_mode);
  return {
    creator,
    product: row,
    usableRails: usableRailsOf(resolution),
    activeRailCount: resolution.kind === "ok" ? resolution.activeCount : 0,
    railKind: resolution.kind,
  };
});

export { isHouseCreator } from "../../lib/house";

/** Shared publication attribution sentence used identically on the product and checkout pages. */
export function PublicationByline({
  creatorHandle,
  creatorDisplayName,
  creatorIsHouse,
  linkCreator = false,
}: {
  creatorHandle: string;
  creatorDisplayName: string;
  creatorIsHouse: boolean;
  linkCreator?: boolean;
}) {
  const brand = GLOBAL.storefront.brand_name;
  if (creatorIsHouse) {
    return (
      <p className="text-sm text-gray-600">
        {`Published by `}
        <span className="font-medium text-gray-800">{brand}</span>
      </p>
    );
  }
  return (
    <p className="text-sm text-gray-600">
      {`A creator-collaboration publication with `}
      {linkCreator ? (
        <Link href={`/books/${creatorHandle}`} className="font-medium text-gray-800 hover:underline underline-offset-4">
          {creatorDisplayName}
        </Link>
      ) : (
        <span className="font-medium text-gray-800">{creatorDisplayName}</span>
      )}
    </p>
  );
}

/** Well-formed {label, text} entries from products.inside, others dropped. */
export function insideItems(raw: unknown): Array<{ label: string; text: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is { label: string; text: string } =>
      typeof i === "object" && i !== null && typeof i.label === "string" && i.label !== "" && typeof i.text === "string" && i.text !== "",
  );
}

/** Unlaunched storefront pages stay out of search indexes (as the retired
 *  static pages did); only a page with something actually for sale indexes. */
export const NOINDEX = { index: false, follow: false } as const;
export function storefrontRobots(products: Array<Pick<StoreProduct, "checkout_mode">>) {
  return products.some((storeProduct) => storeProduct.checkout_mode === "live") ? undefined : NOINDEX;
}

export function resolveCreatorOr404<T>(result: T | null): T {
  if (!result) notFound();
  return result;
}

const PLATFORM_URLS: Record<string, { name: string; url: (h: string) => string }> = {
  youtube: { name: "YouTube", url: (h) => `https://youtube.com/@${h}` },
  instagram: { name: "Instagram", url: (h) => `https://instagram.com/${h}` },
  tiktok: { name: "TikTok", url: (h) => `https://tiktok.com/@${h}` },
  x: { name: "X", url: (h) => `https://x.com/${h}` },
};

/** Unknown platforms get a text-only label (url null) — never a guessed link. */
export function platformLink(platform: string, handle: string): { label: string; url: string | null } {
  const known = PLATFORM_URLS[platform.toLowerCase()];
  if (known) return { label: `${known.name} @${handle}`, url: known.url(handle) };
  return { label: `${platform.charAt(0).toUpperCase()}${platform.slice(1)} @${handle}`, url: null };
}

/** Buyer legal links (privacy, terms, refund) show on every buyer page when `storefront.always_show_buyer_legal` is true
 *  (default, KYC requirement), including gated samples. The support address comes from the registry (email.support),
 *  the same address the buyer emails use. It is plain text, not a mailto link: the B2C confinement rule
 *  (e2e/b2c-confinement.spec.ts) allows only /books, the B2C home and checkout. */
export function StorefrontFooter({ showBuyerLegal = GLOBAL.storefront.always_show_buyer_legal }: { showBuyerLegal?: boolean }) {
  return (
    <BrandFooter>
      {showBuyerLegal && (
        <>
          {GLOBAL.storefront.buyer_legal_links.map((link) => (
            <a key={link.path} href={link.path} className="hover:text-gray-700 transition-colors">
              {link.label}
            </a>
          ))}
        </>
      )}
      <span>{GLOBAL.email.support}</span>
    </BrandFooter>
  );
}

/** Strip any trailing "(Sample)" suffix when rendering a separate sample badge so "(Sample)" never doubles. */
export function formatCoverFooterTitle(
  title: string,
  isSample: boolean,
  sampleLabel: string = GLOBAL.storefront.sample_badge_label,
): { baseTitle: string; sampleBadge: string | null } {
  if (!isSample) return { baseTitle: title, sampleBadge: null };
  const stripped = title.replace(/\s*\(sample\)\s*$/i, "").trim();
  return { baseTitle: stripped || title, sampleBadge: sampleLabel };
}

/** Book cover card frame: deep-charcoal DIGITAL PDF header strip, middle area showing the book's actual cover
 *  image keeping its true aspect ratio (or typographic fallback), and deep-charcoal footer strip with title,
 *  "(Sample)" where it applies, and the publisher name (storefront.publisher_label). */
export function BookCover({
  title,
  kicker = GLOBAL.storefront.digital_pdf_kicker,
  publisher = GLOBAL.storefront.publisher_label,
  coverImage = null,
  isSample = false,
  sampleLabel = GLOBAL.storefront.sample_badge_label,
  className = "",
}: {
  title: string;
  kicker?: string;
  publisher?: string;
  coverImage?: string | null;
  isSample?: boolean;
  sampleLabel?: string;
  className?: string;
}) {
  const { baseTitle, sampleBadge } = formatCoverFooterTitle(title, isSample, sampleLabel);
  return (
    <div
      data-testid="book-cover-card"
      className={`relative overflow-hidden rounded-[24px] bg-charcoal text-white flex flex-col shadow-[0_20px_50px_rgba(0,0,0,0.12)] ${className}`.trim()}
    >
      <div className="relative z-10 bg-charcoal px-5 py-3 border-b border-white/10">
        <p className="text-[10px] font-mono font-medium tracking-[0.16em] uppercase text-gray-300">{kicker}</p>
      </div>

      <div className="relative aspect-[2/3] w-full flex-1 bg-[#121212] flex items-center justify-center p-3 overflow-hidden">
        {coverImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverImage}
            alt={`${baseTitle}${sampleBadge ? ` ${sampleBadge}` : ""} book cover`}
            className="max-h-full max-w-full w-auto h-auto object-contain rounded-[6px] shadow-[0_12px_30px_rgba(0,0,0,0.45)]"
          />
        ) : (
          <div aria-hidden="true" className="relative w-full h-full flex items-center justify-center p-4 text-center">
            <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-peach/20 blur-3xl pointer-events-none" />
            <p className="relative text-xl sm:text-2xl font-bold tracking-tight leading-[1.15] text-white">{baseTitle}</p>
          </div>
        )}
      </div>

      <div className="relative z-10 bg-charcoal px-5 py-3.5 border-t border-white/10 flex flex-col gap-1">
        <p className="text-sm font-semibold tracking-tight leading-snug text-white line-clamp-2">
          {baseTitle}
          {sampleBadge && (
            <span className="ml-1.5 font-mono text-[11px] font-medium text-peach">{sampleBadge}</span>
          )}
        </p>
        <p className="text-[10px] font-mono font-medium tracking-[0.16em] uppercase text-peach">{publisher}</p>
      </div>
    </div>
  );
}

/** One book in a grid: cover, title, creator, price, and coming-soon/preview CTA for non-live samples. Used by /books and the creator shelf. */
export function BookCard({
  product,
  creatorHandle,
  creatorName,
  headingLevel = 2,
}: {
  product: Pick<StoreProduct, "slug" | "title" | "price_usd" | "cover_image" | "is_sample" | "usable_rail_count"> & {
    currency?: string | null;
    checkout_mode?: string | null;
  };
  creatorHandle: string;
  creatorName: string;
  headingLevel?: 2 | 3;
}) {
  const slug = productSlugOf(product);
  const title = product.title ?? slug;
  const price = priceOf(product);
  const { formatted, currency } = formatProductPrice(price, product.currency);
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const isNonLive = typeof product.checkout_mode === "string" && product.checkout_mode !== "live";
  // Same rule as the product and checkout pages: live, priced, and at least one usable rail. Otherwise "Coming soon".
  const purchasable = isPurchasableProduct(product, product.usable_rail_count ?? 0);
  const productHref = `/books/${creatorHandle}/${slug}`;
  return (
    <article className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-5 sm:p-6 h-full flex flex-col gap-5">
      <BookCover title={title} coverImage={product.cover_image ?? null} isSample={product.is_sample ?? false} />
      <div className="flex flex-col gap-1.5">
        <Heading className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 leading-snug">
          <Link href={productHref} className="hover:underline underline-offset-4">
            {title}
          </Link>
        </Heading>
        <p className="text-xs sm:text-sm text-gray-600">
          {"by "}
          <Link href={`/books/${creatorHandle}`} className="font-medium text-gray-800 hover:underline underline-offset-4">
            {creatorName}
          </Link>
        </p>
      </div>
      <div className="mt-auto flex flex-col gap-3">
        <p className="text-lg font-bold text-gray-900">
          {formatted}{" "}
          <span className="text-xs font-normal text-gray-600">{`${currency} · one-time`}</span>
        </p>
        {isNonLive && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span
              data-checkout-mode={product.checkout_mode ?? undefined}
              className="inline-flex items-center rounded-full border border-[#dcc7b4] bg-white/75 px-3 py-1 text-xs font-semibold text-gray-700"
            >
              {GLOBAL.storefront.coming_soon_badge}
            </span>
            <Link
              href={productHref}
              className="text-xs font-semibold text-gray-900 underline underline-offset-4 hover:text-gray-700"
            >
              {GLOBAL.storefront.sample_preview_cta}
            </Link>
          </div>
        )}
        {!isNonLive && !purchasable && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span
              data-checkout-mode={priceOf(product) === null ? "unpriced" : "no_rail"}
              className="inline-flex items-center rounded-full border border-[#dcc7b4] bg-white/75 px-3 py-1 text-xs font-semibold text-gray-700"
            >
              {GLOBAL.storefront.coming_soon_badge}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
