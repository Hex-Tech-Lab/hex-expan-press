import { notFound } from "next/navigation";
import "server-only";
import "./storefront.css";
import { getSupabaseAdmin } from "../../../../payments/src/supabase_admin";

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
  composite_slug: string | null;
  site_slug: string | null;
  slug: string | null;
  title: string | null;
  /** PostgREST returns numeric columns as strings — always coerce. */
  price_usd: string | number | null;
  currency: string | null;
  working_note: string | null;
  description: string | null;
  disclaimers: string[] | null;
}

export interface HubCreator {
  handle: string;
  display_name: string;
  platform_handles: Record<string, string> | null;
  bio: string | null;
  photo: string | null;
  products: StoreProduct[];
}

/** The DB-valid handle charset (creators.handle CHECK, portal migration). */
export const CREATOR_HANDLE_RE = /^[a-z0-9_-]{2,64}$/;
/** The DB-valid slug charset (products.slug CHECK, portal migration). */
export const PRODUCT_SLUG_RE = /^[a-z0-9-]{2,80}$/;

/** product_slug comes from site_slug's second segment ("handle/product_slug"),
 * falling back to the portal slug — same derivation the baker used. */
export function productSlugOf(p: StoreProduct): string {
  const siteSlug = typeof p.site_slug === "string" ? p.site_slug : "";
  if (siteSlug.includes("/")) return siteSlug.split("/")[1] ?? "";
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

export async function fetchCreatorHub(handle: string): Promise<{ creator: HubCreator; origin: string } | null> {
  if (!CREATOR_HANDLE_RE.test(handle)) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — hub cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("creators")
    .select(
      "handle, display_name, platform_handles, bio, photo, products(id, store_product_id, composite_slug, site_slug, slug, title, price_usd, currency, working_note, description, disclaimers)",
    )
    .eq("handle", handle)
    .maybeSingle();
  if (error) throw new Error(`storefront: creator hub query failed for '${handle}': ${error.message}`);
  const creator = data as HubCreator | null;
  const products = commercialProducts(creator?.products);
  if (!creator || products.length === 0) return null;
  const origin = await fetchSiteOrigin(supabase);
  return { creator: { ...creator, products }, origin };
}

export async function fetchStoreProduct(
  handle: string,
  productSlug: string,
): Promise<{ creator: HubCreator; product: StoreProduct; origin: string } | null> {
  if (!CREATOR_HANDLE_RE.test(handle) || !PRODUCT_SLUG_RE.test(productSlug)) return null;
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    throw new Error("storefront: Supabase admin client unavailable — product page cannot render (fail closed)");
  }
  const { data, error } = await supabase
    .from("creators")
    .select(
      "handle, display_name, platform_handles, bio, photo, products(id, store_product_id, composite_slug, site_slug, slug, title, price_usd, currency, working_note, description, disclaimers)",
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
}

export function resolveCreatorOr404<T>(result: T | null): T {
  if (!result) notFound();
  return result;
}

/* Design tokens carried over from the baked pages (PRODUCT_CSS in the retired
 * bake engine) — every selector scoped under .sf-root so nothing leaks into
 * the app's global element styles. */

export function platformLink(platform: string, handle: string): { label: string; url: string } {
  return platform === "youtube"
    ? { label: `YouTube @${handle}`, url: `https://youtube.com/@${handle}` }
    : { label: `${platform.charAt(0).toUpperCase()}${platform.slice(1)} @${handle}`, url: `https://instagram.com/${handle}` };
}

export function StorefrontFooter() {
  return (
    <footer>
      <a href="/privacy.html">Privacy Policy</a>
      <span className="sep">&middot;</span>
      <a href="/terms.html">Terms of Service</a>
      <span className="sep">&middot;</span>
      <a href="/refund-policy.html">Refund Policy</a>
      <span className="sep">&middot;</span>
      <span>Support: support@expanpress.com</span>
    </footer>
  );
}
