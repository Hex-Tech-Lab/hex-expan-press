import type { Metadata } from "next";
import Link from "next/link";
import {
  NOINDEX,
  StorefrontFooter,
  fetchB2cLanding,
  productSlugOf,
  priceOf,
} from "../../src/components/storefront/storefront";
import { GLOBAL } from "../../../payments/src/settings_registry";

/**
 * B2C landing (/books). Every buyer-side logo and home link resolves here
 * (settings: storefront.b2c_landing_url). It lists only creators with a live
 * product, so a buyer who presses home stays in the B2C side and never reaches
 * the B2B root. The page renders per request: the storefront fails closed when
 * the database is unavailable, and a build-time prerender would fail the build.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Books by creators · ExpanPress",
  description: "Browse the books creators have published on ExpanPress.",
  robots: NOINDEX,
};

export default async function B2cLandingPage() {
  const creators = await fetchB2cLanding();
  const home = GLOBAL.storefront.b2c_landing_url;

  return (
    <div className="sf-root">
      <div className="wrap">
        <header className="thanks-top">
          <Link href={home} className="logo" aria-label="ExpanPress home">
            ExpanPress
          </Link>
        </header>

        <p className="kicker">Books by creators</p>
        <h1>Find a book from a creator</h1>

        {creators.length === 0 ? (
          <p>No books are on sale yet. Please check back soon.</p>
        ) : (
          <div className="products">
            {creators.map((c) => (
              <section key={c.handle} className="card">
                <h2>
                  <Link href={`/books/${c.handle}`}>{c.display_name}</Link>
                </h2>
                <ul>
                  {c.products.map((p) => {
                    const price = priceOf(p);
                    return (
                      <li key={p.id}>
                        <Link href={`/books/${c.handle}/${productSlugOf(p)}`}>{p.title ?? productSlugOf(p)}</Link>
                        {price !== null ? ` · $${price.toFixed(2)}` : ""}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
      <StorefrontFooter />
    </div>
  );
}
