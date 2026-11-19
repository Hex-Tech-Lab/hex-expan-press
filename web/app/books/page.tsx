import type { Metadata } from "next";
import { BookCard, NOINDEX, StorefrontFooter, fetchB2cLanding } from "../../src/components/storefront/storefront";
import { BrandFrame, BrandWordmark } from "../../src/components/brand/brand";
import { GLOBAL } from "../../../payments/src/settings_registry";
import { AttributionCapture } from "../../src/components/storefront/buy-link";

/**
 * B2C landing (/books). Every buyer-side logo and home link resolves here
 * (settings: storefront.b2c_landing_url). It lists only creators with a live
 * product, so a buyer who presses home stays in the B2C side and never reaches
 * the B2B root. The page renders per request: the storefront fails closed when
 * the database is unavailable, and a build-time prerender would fail the build.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Books by creators · ${GLOBAL.storefront.brand_name}`,
  description: `Browse the books creators have published on ${GLOBAL.storefront.brand_name}.`,
  robots: NOINDEX,
};

export default async function B2cLandingPage() {
  const creators = await fetchB2cLanding();
  const home = GLOBAL.storefront.b2c_landing_url;
  const books = creators.flatMap((creator) => creator.products.map((product) => ({ product, creator })));

  return (
    <BrandFrame>
      {/* Keeps ?src / ?dub_id from the landing URL so a product bought from here is attributed, not "direct". */}
      <AttributionCapture />

      <header className="flex items-center justify-between">
        <BrandWordmark href={home} label="ExpanPress home" />
      </header>

      <main className="flex flex-col gap-6 md:gap-8">
        <section className="relative overflow-hidden rounded-[32px] bg-charcoal text-white p-8 sm:p-10 md:p-12">
          <div aria-hidden="true" className="absolute -left-12 top-1/4 w-36 h-72 rounded-full bg-peach/20 blur-3xl pointer-events-none" />
          <div className="relative max-w-xl">
            <p className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-400 mb-6">
              Books by creators
            </p>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-white leading-[1.12]">
              Find a book from a creator
            </h1>
            <p className="mt-5 text-sm sm:text-base text-gray-300 leading-relaxed">
              Pay once for a digital PDF. Checkout is secure and hosted by our payment partners, and your download link is
              emailed after purchase.
            </p>
          </div>
        </section>

        {books.length === 0 ? (
          <section className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-8 text-center">
            <p className="text-base text-gray-700">No books are on sale yet. Please check back soon.</p>
          </section>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
            {books.map(({ product, creator }) => (
              <li key={product.id} className="list-none">
                <BookCard product={product} creatorHandle={creator.handle} creatorName={creator.display_name} />
              </li>
            ))}
          </ul>
        )}
      </main>

      <StorefrontFooter />
    </BrandFrame>
  );
}
