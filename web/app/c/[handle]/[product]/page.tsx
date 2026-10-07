import type { Metadata } from "next";
import Link from "next/link";
import {
  StorefrontFooter,
  fetchStoreProduct,
  isWorkingTitle,
  priceOf,
  resolveCreatorOr404,
} from "../../../../src/components/storefront/storefront";

/**
 * Product page — SSR (Sprint 16). Replaces the frozen baked
 * public/c/<handle>/<product>/index.html (an orphan artifact of the deleted
 * bake engine whose CTA still read "Checkout coming online" while the checkout
 * route was live). The buy CTA now points at the live DB-driven checkout route,
 * which enforces the consent gate and routes through the DB rails.
 */
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string; product: string }>;
}): Promise<Metadata> {
  const { handle, product } = await params;
  const result = await fetchStoreProduct(handle, product);
  if (!result) return { title: "Publication · ExpanPress" };
  const { creator, product: p, origin } = result;
  const title = `${p.title ?? p.composite_slug} · ${creator.display_name} · ExpanPress`;
  const description = (p.description ?? `A publication by ${creator.display_name} on ExpanPress.`).slice(0, 155);
  const canonical = `${origin}/c/${creator.handle}/${product}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", siteName: "ExpanPress", title, description, url: canonical },
    twitter: { card: "summary", title, description },
  };
}

export default async function StoreProductPage({
  params,
}: {
  params: Promise<{ handle: string; product: string }>;
}) {
  const { handle, product } = await params;
  const { creator, product: p } = resolveCreatorOr404(await fetchStoreProduct(handle, product));

  const price = priceOf(p);
  const buyUrl = `/api/billing/checkout?product=${encodeURIComponent(p.store_product_id ?? "")}`;

  return (
    <div className="sf-root">
      <div className="wrap">
        <p className="kicker">Digital PDF &middot; Instant Download</p>
        <Link href={`/c/${creator.handle}`} className="backlink">
          &larr; Back to {creator.display_name}&rsquo;s page
        </Link>
        <h1>{p.title ?? p.composite_slug}</h1>
        <p className="byline">
          A creator-collaboration publication &middot; with <b>{creator.display_name}</b>
        </p>
        {isWorkingTitle(p) && (
          <p className="wt-note">Product shown under a working title &mdash; final title may change before publication.</p>
        )}

        {p.description && <p className="desc">{p.description}</p>}

        <div className="pricebox">
          <p className="card-price">
            ${price ?? "—"} <small>{p.currency ?? "USD"} &middot; one-time</small>
          </p>
        </div>
        <p className="taxnote">Sales tax / VAT is calculated and collected at checkout by our payment partners.</p>

        <a className="buybtn" href={buyUrl}>
          Buy now &mdash; secure checkout
        </a>
        <p className="assurance">Secure checkout hosted by our payment partners &middot; PDF delivered by email</p>

        {(p.disclaimers ?? []).length > 0 && (
          <div className="disclaimers">
            {(p.disclaimers ?? []).map((d, i) => (
              <p key={i}>{d}</p>
            ))}
          </div>
        )}

        <StorefrontFooter />
      </div>
    </div>
  );
}
