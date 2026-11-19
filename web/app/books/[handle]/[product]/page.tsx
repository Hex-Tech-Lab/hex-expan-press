import type { Metadata } from "next";
import Link from "next/link";
import { BuyLink } from "../../../../src/components/storefront/buy-link";
import BookPreviewer from "../../../../src/components/storefront/book-previewer";
import { ArrowIcon, BrandFrame, BrandWordmark } from "../../../../src/components/brand/brand";
import {
  BookCover,
  NOINDEX,
  PAY_ORIGIN,
  StorefrontFooter,
  storefrontRobots,
  fetchStoreProduct,
  isWorkingTitle,
  priceOf,
  productSlugOf,
  resolveCreatorOr404,
} from "../../../../src/components/storefront/storefront";
import { GLOBAL } from "../../../../../payments/src/settings_registry";

/**
 * Product page — SSR (Sprint 16). Replaces the frozen baked
 * public/c/<handle>/<product>/index.html (an orphan artifact of the deleted
 * bake engine whose CTA still read "Checkout coming online" while the checkout
 * route was live). The buy CTA now points at the live DB-driven checkout route,
 * which enforces the consent gate and routes through the DB rails.
 *
 * Deliberately short: cover, title, creator, description, price, one buy button,
 * and the buyer legal links in the footer.
 */
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string; product: string }>;
}): Promise<Metadata> {
  const { handle, product } = await params;
  const result = await fetchStoreProduct(handle, product);
  if (!result) return { title: "Publication · ExpanPress", robots: NOINDEX };
  const { creator, product: p, origin } = result;
  const title = `${p.title ?? p.slug} · ${creator.display_name} · ExpanPress`;
  const description = (p.description ?? `A publication by ${creator.display_name} on ExpanPress.`).slice(0, 155);
  const canonical = `${origin}/books/${creator.handle}/${product}`;
  return {
    robots: storefrontRobots([p]),
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
  const live = p.checkout_mode === "live";
  const title = p.title ?? productSlugOf(p);
  const buyUrl = `${PAY_ORIGIN}/checkout/${p.id}`;

  return (
    <BrandFrame>
      <header className="flex items-center justify-between">
        <BrandWordmark href={GLOBAL.storefront.b2c_landing_url} label="ExpanPress home" />
      </header>

      <main className="flex flex-col gap-6 md:gap-8">
        <div className="grid gap-6 md:grid-cols-2 md:gap-8 md:items-start">
          <div className="w-full max-w-sm mx-auto md:mx-0">
            <BookCover title={title} coverImage={p.cover_image ?? null} isSample={p.is_sample ?? false} />
          </div>

          <section className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8 flex flex-col gap-5">
          <Link
            href={`/books/${creator.handle}`}
            className="self-start text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline underline-offset-4"
          >
            &larr; Back to {creator.display_name}&rsquo;s books
          </Link>

          <div className="flex flex-col gap-3">
            <p className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-600">
              Digital PDF &middot; Download link by email
            </p>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 leading-[1.12]">{title}</h1>
            <p className="text-sm text-gray-600">
              A creator-collaboration publication with{" "}
              <Link
                href={`/books/${creator.handle}`}
                className="font-medium text-gray-800 hover:underline underline-offset-4"
              >
                {creator.display_name}
              </Link>
            </p>
            {isWorkingTitle(p) && (
              <p className="text-xs italic text-gray-600">
                Product shown under a working title &mdash; final title may change before publication.
              </p>
            )}
          </div>

          {p.description && <p className="text-base text-gray-700 leading-relaxed">{p.description}</p>}

          <p className="text-2xl font-bold tracking-tight text-gray-900">
            {price !== null ? `$${price.toFixed(2)}` : "—"}{" "}
            <span className="text-xs font-normal text-gray-600">{`${p.currency ?? "USD"} · one-time`}</span>
          </p>

          {live ? (
            <BuyLink
              className="self-start inline-flex items-center gap-3 rounded-full bg-[#2A2A2A] hover:bg-[#383838] text-white px-6 py-3.5 text-sm font-semibold transition-colors"
              href={buyUrl}
              data-checkout-slot="primary"
              data-checkout-mode="live"
            >
              Buy now &mdash; secure checkout
              <ArrowIcon />
            </BuyLink>
          ) : (
            <p
              className="self-start rounded-full border border-[#dcc7b4] bg-white/60 px-6 py-3.5 text-sm font-semibold text-gray-700"
              aria-disabled="true"
              data-checkout-slot="primary"
              data-checkout-mode="gated"
            >
              Coming soon &mdash; not yet available for purchase
            </p>
          )}

          <p className="text-xs text-gray-600">Secure checkout hosted by our payment partners &middot; A download link is emailed after purchase</p>
          <p className="text-xs text-gray-600">Sales tax / VAT is calculated and collected at checkout by our payment partners.</p>

          {(p.disclaimers ?? []).map((d, i) => (
            <p key={i} className="text-xs text-gray-600 leading-relaxed">
              {d}
            </p>
          ))}
          </section>
        </div>

        {p.preview_pdf && (
          <BookPreviewer
            previewPdfUrl={p.preview_pdf}
            bookTitle={title}
            settings={GLOBAL.book_preview}
          />
        )}
      </main>

      <StorefrontFooter showBuyerLegal={live} />
    </BrandFrame>
  );
}
