import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import "server-only";
import { getSupabaseAdmin } from "../../../../payments/src/supabase_admin";
import { GLOBAL, isEnabledPaymentProvider } from "../../../../payments/src/settings_registry";
import { guidSchema, productSlugSchema } from "../../lib/zod-rules";
import { resolveProductBookAssets } from "../../lib/book-assets";
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
 * these pages render public marketing content only (profile, title, price,
 * description), never terms/consent/rails state.
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
  is_sample?: boolean;
  overview?: string | null;
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
export function productSlugOf(p: Pick<StoreProduct, "slug">): string {
  return p.slug ?? "";
}

/** numeric-as-string coercion with a finite guard (Sprint 15 money-path rule). */
export function priceOf(p: Pick<StoreProduct, "price_usd">): number | null {
  if (p.price_usd == null) return null;
  const n = Number(p.price_usd);
  return Number.isFinite(n) ? n : null;
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

export function isWorkingTitle(p: StoreProduct): boolean {
  return typeof p.working_note === "string" && p.working_note.toUpperCase().startsWith("WORKING");
}

/** Only commercial products (store_product_id) belong on a storefront. */
export function commercialProducts<T extends { store_product_id: string | null }>(products: T[] | null | undefined): T[] {
  return (products ?? []).filter((p) => typeof p.store_product_id === "string" && p.store_product_id !== "");
}

async function fetchSiteOrigin(supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>): Promise<string> {
  const { data, error } = await supabase.from("system_config").select("value").eq("key", "site.origin").maybeSingle();
  if (error) throw new Error(`storefront: site.origin lookup failed: ${error.message}`);
  const origin = String((data as { value?: unknown } | null)?.value ?? "https://expanpress.com").replace(/\/$/, "");
  return origin;
}

function withResolvedAssets<T extends { slug: string | null; title: string | null; book_registry?: string | null }>(p: T): T & {
  book_registry: string | null;
  cover_image: string | null;
  preview_pdf: string | null;
  is_sample: boolean;
  overview: string | null;
} {
  const assets = resolveProductBookAssets(p);
  return {
    ...p,
    book_registry: assets.book_registry,
    cover_image: assets.cover_image,
    preview_pdf: assets.preview_pdf,
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
      "handle, display_name, platform_handles, bio, photo, is_house, products(id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside, book_registry)",
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
  const products = commercial.map(withResolvedAssets).filter((p) => isVisibleStorefrontProduct(p));
  return { creator: { ...creator, products }, origin };
});

/** The fields /books renders (price, title, link, cover). No heavy detail columns are transferred for the landing. */
export type LandingProduct = Pick<
  StoreProduct,
  "id" | "store_product_id" | "slug" | "title" | "price_usd" | "checkout_mode" | "book_registry" | "cover_image" | "is_sample"
>;
export interface LandingCreator {
  handle: string;
  display_name: string;
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
    .select("handle, display_name, products!inner(id, store_product_id, slug, title, price_usd, checkout_mode, book_registry)");
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
        .map(withResolvedAssets)
        .filter((p) => isVisibleStorefrontProduct(p)),
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
      "handle, display_name, platform_handles, bio, photo, is_house, products(id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside, book_registry)",
    )
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw new Error(`storefront: product page query failed for '${handle}/${productSlug}': ${error.message}`);
  const creator = data as HubCreator | null;
  if (!creator) return null;
  const product = commercialProducts(creator.products).find((p) => productSlugOf(p) === productSlug);
  if (!product) return null;
  const origin = await fetchSiteOrigin(supabase);
  return { creator, product: withResolvedAssets(product), origin };
});

/** The single provider-agnostic checkout origin (ADR 0061). Buy links and the checkout page live here. */
export const PAY_ORIGIN = "https://pay.expanpress.com";


/** Checkout page lookup by product UUID (ADR 0061). Commercial products only, same rule as the storefront. */
export const fetchCheckoutProduct = cache(async function fetchCheckoutProduct(
  productId: string,
): Promise<{ creator: { handle: string; display_name: string }; product: StoreProduct; railProvider: string | null } | null> {
  if (!guidSchema.safeParse(productId).success) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — checkout page cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("products")
    .select(
      "id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, paddle_price_id, inside, creators(handle, display_name)",
    )
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(`storefront: checkout product query failed for '${productId}': ${error.message}`);
  if (!data) return null;
  const row = data as unknown as StoreProduct & { creators: { handle: string; display_name: string } | Array<{ handle: string; display_name: string }> | null };
  const creator = Array.isArray(row.creators) ? row.creators[0] : row.creators;
  if (!creator || commercialProducts([row]).length === 0) return null;
  const { data: railRows, error: railErr } = await supabase
    .from("product_rails")
    .select("provider, weight, active")
    .eq("product_id", productId)
    .order("weight", { ascending: false });
  if (railErr) throw new Error(`storefront: checkout rails query failed for '${productId}': ${railErr.message}`);
  const activeRail = (railRows ?? []).find(
    (r) =>
      r !== null &&
      typeof r === "object" &&
      ((r as { active?: unknown }).active === true || (r as { active?: unknown }).active === "true") &&
      typeof (r as { provider?: unknown }).provider === "string" &&
      isEnabledPaymentProvider((r as { provider: string }).provider),
  ) as { provider: string } | undefined;
  return { creator, product: row, railProvider: activeRail?.provider ?? null };
});

/** True when the creator display name equals the house brand (settings: storefront.brand_name). */
export function isHouseCreator(displayName: string, brandName: string = GLOBAL.storefront.brand_name): boolean {
  return displayName.trim() === brandName.trim();
}

/** Shared publication attribution sentence used identically on the product and checkout pages. */
export function PublicationByline({
  creatorHandle,
  creatorDisplayName,
  linkCreator = false,
}: {
  creatorHandle: string;
  creatorDisplayName: string;
  linkCreator?: boolean;
}) {
  const brand = GLOBAL.storefront.brand_name;
  if (isHouseCreator(creatorDisplayName, brand)) {
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
  return products.some((p) => p.checkout_mode === "live") ? undefined : NOINDEX;
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
  product: Pick<StoreProduct, "slug" | "title" | "price_usd" | "cover_image" | "is_sample"> & {
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
      </div>
    </article>
  );
}
