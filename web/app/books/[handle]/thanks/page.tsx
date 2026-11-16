import type { Metadata } from "next";
import Link from "next/link";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import {
  NOINDEX,
  StorefrontFooter,
  fetchCreatorHub,
  priceOf,
  productSlugOf,
  resolveCreatorOr404,
  type StoreProduct,
} from "../../../../src/components/storefront/storefront";

/**
 * Thank-you return page. Checkout sends the buyer here (success URL = /books/{handle}/thanks).
 * Logo -> the B2C landing (registry storefront.b2c_landing_url). Home -> the same creator.
 * Upsell: the creator's live products. Never indexed.
 */
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const result = await fetchCreatorHub(handle);
  const title = result ? `Thank you · ${result.creator.display_name} · ExpanPress` : "Thank you · ExpanPress";
  return { title, robots: NOINDEX };
}

export default async function ThankYouPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const { creator } = resolveCreatorOr404(await fetchCreatorHub(handle));
  const logoHref = GLOBAL.storefront.b2c_landing_url;
  const creatorHref = `/books/${creator.handle}`;

  return (
    <div className="sf-root">
      <div className="wrap">
        <header className="thanks-top">
          <Link href={logoHref} className="logo" aria-label="ExpanPress home">
            ExpanPress
          </Link>
          <nav>
            <Link href={creatorHref}>Home: {creator.display_name}</Link>
          </nav>
        </header>

        <main>
        <p className="kicker">Purchase complete</p>
        <h1>Thank you for your purchase</h1>
        <p>Your download link is sent to the email you used at checkout.</p>

        <div className="products">
          <h2>More from {creator.display_name}</h2>
          <div className="grid">
            {creator.products.map((p: StoreProduct) => {
              const price = priceOf(p);
              return (
                <Link key={p.id} href={`/books/${creator.handle}/${productSlugOf(p)}`} className="card">
                  <div className="cover">
                    <p className="cover-kicker">Digital PDF</p>
                    <p className="cover-title">{p.title ?? p.slug}</p>
                  </div>
                  <div className="card-body">
                    <p className="card-price">
                      ${price ?? "—"} <small>{p.currency ?? "USD"} &middot; one-time</small>
                    </p>
                    <p className="card-cta">View details &rarr;</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        </main>

        <StorefrontFooter />
      </div>
    </div>
  );
}
