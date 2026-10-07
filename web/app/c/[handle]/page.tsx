import type { Metadata } from "next";
import Link from "next/link";
import {
  StorefrontFooter,
  fetchCreatorHub,
  isWorkingTitle,
  platformLink,
  priceOf,
  productSlugOf,
  resolveCreatorOr404,
  type StoreProduct,
} from "../../../src/components/storefront/storefront";

/**
 * Creator hub — SSR (Sprint 16). Replaces the frozen baked
 * public/c/<handle>/index.html: prices, product list, and availability render
 * from the Postgres SSOT with at most 60s of staleness instead of freezing at
 * bake time.
 */
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const result = await fetchCreatorHub(handle);
  if (!result) return { title: "Creator page · ExpanPress" };
  const { creator, origin } = result;
  const title = `${creator.display_name} — Creator page · ExpanPress`;
  const description = creator.bio
    ? creator.bio.slice(0, 155)
    : `Publications by ${creator.display_name} on ExpanPress.`;
  const canonical = `${origin}/c/${creator.handle}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", siteName: "ExpanPress", title, description, url: canonical },
    twitter: { card: "summary", title, description },
  };
}

export default async function CreatorHubPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const { creator } = resolveCreatorOr404(await fetchCreatorHub(handle));

  const initial = creator.display_name.trim().charAt(0).toUpperCase();
  const bioParas = creator.bio
    ? creator.bio
        .split(/\n{2,}/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return (
    <div className="sf-root">
      <div className="wrap">
        <p className="kicker">Creator page &middot; ExpanPress</p>
        {creator.photo ? (
          <div className="avatar">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={creator.photo} alt={creator.display_name} />
          </div>
        ) : (
          <div className="avatar" aria-label={creator.display_name}>
            {initial}
          </div>
        )}
        <h1>{creator.display_name}</h1>
        <p className="handles">
          {Object.entries(creator.platform_handles ?? {}).map(([platform, ph], i) => {
            const link = platformLink(platform, ph);
            return (
              <span key={platform}>
                {i > 0 && <span className="sep"> &middot; </span>}
                <a href={link.url} rel="noopener">
                  {link.label}
                </a>
              </span>
            );
          })}
        </p>
        {bioParas.length > 0 ? (
          <div className="bio">
            {bioParas.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        ) : (
          <p className="bio">Creator bio coming soon.</p>
        )}

        <div className="products">
          <h2>Publications</h2>
          <div className="grid">
            {creator.products.map((p: StoreProduct) => {
              const price = priceOf(p);
              return (
                <Link
                  key={p.id}
                  href={`/c/${creator.handle}/${productSlugOf(p)}`}
                  className="card"
                  data-card-source={`supabase:products/${p.id}`}
                >
                  <div className="cover">
                    <p className="cover-kicker">Digital PDF</p>
                    <p className="cover-title">{p.title ?? p.composite_slug}</p>
                  </div>
                  <div className="card-body">
                    <p className="card-price">
                      ${price ?? "—"} <small>{p.currency ?? "USD"} &middot; one-time</small>
                    </p>
                    {isWorkingTitle(p) && (
                      <p className="wt-note">Working title &mdash; final title may change before publication.</p>
                    )}
                    <p className="card-cta">View details &rarr;</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        <div className="disclaimers">
          <p>
            <b>Educational content only &mdash; not financial advice.</b> The publications listed on this page are
            educational; nothing in them is a recommendation to buy, sell, or hold any security. See each
            publication&rsquo;s page for full disclaimers.
          </p>
          <p>
            <b>Digital products:</b> all items are downloadable PDFs; no physical items are shipped.
          </p>
        </div>

        <StorefrontFooter />
      </div>
    </div>
  );
}
