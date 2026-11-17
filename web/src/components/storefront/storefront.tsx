import { cache } from "react";
import { notFound } from "next/navigation";
import "server-only";
import "./storefront.css";
import { getSupabaseAdmin } from "../../../../payments/src/supabase_admin";
import { guidSchema, productSlugSchema } from "../../lib/zod-rules";

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
}

export interface HubCreator {
  handle: string;
  display_name: string;
  platform_handles: Record<string, string> | null;
  bio: string | null;
  photo: string | null;
  products: StoreProduct[];
}

/** Product slug shape comes from the settings registry (product_slug section, ADR 0065). Same rule as the DB CHECK. */

/** The product slug in storefront URLs is products.slug, the agreed rule (ADR 0065, DB CHECK).
 * A product is identified by its creator handle and products.slug only; no stored derived
 * identifier is read. Every product link and the product lookup go through this one function. */
export function productSlugOf(p: StoreProduct): string {
  return p.slug ?? "";
}

/** numeric-as-string coercion with a finite guard (Sprint 15 money-path rule). */
export function priceOf(p: StoreProduct): number | null {
  if (p.price_usd == null) return null;
  const n = Number(p.price_usd);
  return Number.isFinite(n) ? n : null;
}

export function isWorkingTitle(p: StoreProduct): boolean {
  return typeof p.working_note === "string" && p.working_note.toUpperCase().startsWith("WORKING");
}

/** Only commercial products (store_product_id) belong on a storefront. */
export function commercialProducts(products: StoreProduct[] | null | undefined): StoreProduct[] {
  return (products ?? []).filter((p) => typeof p.store_product_id === "string" && p.store_product_id !== "");
}

async function fetchSiteOrigin(supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseAdmin>>>): Promise<string> {
  const { data, error } = await supabase.from("system_config").select("value").eq("key", "site.origin").maybeSingle();
  if (error) throw new Error(`storefront: site.origin lookup failed: ${error.message}`);
  const origin = String((data as { value?: unknown } | null)?.value ?? "https://expanpress.com").replace(/\/$/, "");
  return origin;
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
      "handle, display_name, platform_handles, bio, photo, products(id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside)",
    )
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw new Error(`storefront: creator hub query failed for '${handle}': ${error.message}`);
  const creator = data as HubCreator | null;
  const commercial = commercialProducts(creator?.products);
  if (!creator || commercial.length === 0) return null;
  const origin = await fetchSiteOrigin(supabase);
  // Only live (published) products are rendered or linked from the hub. A gated product keeps its own page.
  // storefrontRobots depends only on whether a live product exists, so its result is unchanged.
  const products = commercial.filter((p) => p.checkout_mode === "live");
  return { creator: { ...creator, products }, origin };
});

/** B2C landing (/books): every creator with at least one live, commercial product. Same data rule as the hub. */
export const fetchB2cLanding = cache(async function fetchB2cLanding(): Promise<HubCreator[]> {
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — B2C landing cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("creators")
    .select(
      "handle, display_name, platform_handles, bio, photo, products(id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside)",
    );
  if (error) throw new Error(`storefront: B2C landing query failed: ${error.message}`);
  const rows = (data ?? []) as HubCreator[];
  return rows
    .map((c) => ({ ...c, products: commercialProducts(c.products).filter((p) => p.checkout_mode === "live") }))
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
      "handle, display_name, platform_handles, bio, photo, products(id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside)",
    )
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw new Error(`storefront: product page query failed for '${handle}/${productSlug}': ${error.message}`);
  const creator = data as HubCreator | null;
  if (!creator) return null;
  const product = commercialProducts(creator.products).find((p) => productSlugOf(p) === productSlug);
  if (!product) return null;
  const origin = await fetchSiteOrigin(supabase);
  return { creator, product, origin };
});

/** The single provider-agnostic checkout origin (ADR 0061). Buy links and the checkout page live here. */
export const PAY_ORIGIN = "https://pay.expanpress.com";


/** Checkout page lookup by product UUID (ADR 0061). Commercial products only, same rule as the storefront. */
export const fetchCheckoutProduct = cache(async function fetchCheckoutProduct(
  productId: string,
): Promise<{ creator: { handle: string; display_name: string }; product: StoreProduct } | null> {
  if (!guidSchema.safeParse(productId).success) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — checkout page cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("products")
    .select("id, store_product_id, slug, title, price_usd, currency, working_note, description, disclaimers, checkout_mode, inside, creators(handle, display_name)")
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(`storefront: checkout product query failed for '${productId}': ${error.message}`);
  if (!data) return null;
  const row = data as unknown as StoreProduct & { creators: { handle: string; display_name: string } | Array<{ handle: string; display_name: string }> | null };
  const creator = Array.isArray(row.creators) ? row.creators[0] : row.creators;
  if (!creator || commercialProducts([row]).length === 0) return null;
  return { creator, product: row };
});

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

/* Design tokens carried over from the baked pages (PRODUCT_CSS in the retired
 * bake engine) — every selector scoped under .sf-root so nothing leaks into
 * the app's global element styles. */

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

/** Buyer legal links are hidden on a gated (draft) product page, which shows a "Coming soon" banner instead of a sale. */
export function StorefrontFooter({ showBuyerLegal = true }: { showBuyerLegal?: boolean }) {
  return (
    <footer>
      {showBuyerLegal && (
        <>
          <a href="/books/legal/privacy.html">Privacy Policy</a>
          <span className="sep">&middot;</span>
          <a href="/books/legal/terms.html">Terms of Sale</a>
          <span className="sep">&middot;</span>
          <a href="/books/legal/refund-policy.html">Refund Policy</a>
          <span className="sep">&middot;</span>
        </>
      )}
      <span>Support: support@expanpress.com</span>
    </footer>
  );
}
