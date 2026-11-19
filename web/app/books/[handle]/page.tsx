import type { Metadata } from "next";
import { AttributionCapture } from "../../../src/components/storefront/buy-link";
import { BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import {
  BookCard,
  NOINDEX,
  StorefrontFooter,
  storefrontRobots,
  fetchCreatorHub,
  platformLink,
  resolveCreatorOr404,
} from "../../../src/components/storefront/storefront";
import { GLOBAL } from "../../../../payments/src/settings_registry";

/**
 * Creator shelf — SSR (Sprint 16). Replaces the frozen baked
 * public/c/<handle>/index.html: prices, product list, and availability render
 * from the Postgres SSOT with at most 60s of staleness instead of freezing at
 * bake time.
 */
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const brand = GLOBAL.storefront.brand_name;
  const result = await fetchCreatorHub(handle);
  if (!result) return { title: `Creator page · ${brand}`, robots: NOINDEX };
  const { creator, origin } = result;
  const title = `${creator.display_name} — Creator page · ${brand}`;
  const description = creator.bio
    ? creator.bio.slice(0, 155)
    : `Publications by ${creator.display_name} on ${brand}.`;
  const canonical = `${origin}/books/${creator.handle}`;
  return {
    robots: storefrontRobots(creator.products),
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", siteName: brand, title, description, url: canonical },
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
    <BrandFrame>
      <AttributionCapture />

      <header className="flex items-center justify-between">
        <BrandWordmark href={GLOBAL.storefront.b2c_landing_url} label="ExpanPress home" />
      </header>

      <main className="flex flex-col gap-6 md:gap-8">
        <section className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center gap-6">
          {creator.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={creator.photo} alt={creator.display_name} width={84} height={84} className="w-20 h-20 shrink-0 rounded-full object-cover" />
          ) : (
            <div
              aria-hidden="true"
              className="w-20 h-20 shrink-0 rounded-full bg-charcoal text-white flex items-center justify-center text-3xl font-bold"
            >
              {initial}
            </div>
          )}
          <div className="flex flex-col gap-3">
            <p className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-600">
              Creator page &middot; ExpanPress
            </p>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 leading-tight">{creator.display_name}</h1>
            <p className="text-sm text-gray-600">
              {Object.entries(creator.platform_handles ?? {}).map(([platform, ph], i) => {
                const link = platformLink(platform, ph);
                return (
                  <span key={platform}>
                    {i > 0 && <span> &middot; </span>}
                    {link.url ? (
                      <a href={link.url} rel="noopener" className="font-medium text-gray-800 hover:underline underline-offset-4">
                        {link.label}
                      </a>
                    ) : (
                      link.label
                    )}
                  </span>
                );
              })}
            </p>
            {bioParas.length > 0 ? (
              bioParas.map((p, i) => (
                <p key={i} className="text-sm sm:text-base text-gray-700 leading-relaxed">
                  {p}
                </p>
              ))
            ) : (
              <p className="text-sm sm:text-base text-gray-600">Creator bio coming soon.</p>
            )}
          </div>
        </section>

        <section aria-labelledby="publications" className="flex flex-col gap-4">
          <h2 id="publications" className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">
            Publications
          </h2>
          {creator.products.length === 0 ? (
            <div className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-8 text-center">
              <p className="text-base text-gray-700">No books are on sale yet. Please check back soon.</p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
              {creator.products.map((p) => (
                <li key={p.id} className="list-none">
                  <BookCard product={p} creatorHandle={creator.handle} creatorName={creator.display_name} headingLevel={3} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2 text-xs text-gray-600 leading-relaxed px-2">
          <p>
            <b className="text-gray-700">Educational content only &mdash; not financial advice.</b> The publications listed on this page are
            educational; nothing in them is a recommendation to buy, sell, or hold any security. See each
            publication&rsquo;s page for full disclaimers.
          </p>
          <p>
            <b className="text-gray-700">Digital products:</b> all items are downloadable PDFs; no physical items are shipped.
          </p>
        </section>
      </main>

      <StorefrontFooter />
    </BrandFrame>
  );
}
