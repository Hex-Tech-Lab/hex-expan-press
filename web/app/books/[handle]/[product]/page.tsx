import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { BuyLink } from "../../../../src/components/storefront/buy-link";
import BookPreviewer from "../../../../src/components/storefront/book-previewer";
import { PreviewScrollCue } from "../../../../src/components/storefront/preview-scroll-cue";
import { ArrowIcon, BrandFrame, BrandWordmark } from "../../../../src/components/brand/brand";
import { resolveProductBookAssets } from "../../../../src/lib/book-assets";
import {
  BookCover,
  NOINDEX,
  PAY_ORIGIN,
  PublicationByline,
  StorefrontFooter,
  storefrontRobots,
  fetchStoreProduct,
  formatProductPrice,
  isHouseCreator,
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
  const brand = GLOBAL.storefront.brand_name;
  const result = await fetchStoreProduct(handle, product);
  if (!result) return { title: `Publication · ${brand}`, robots: NOINDEX };
  const { creator, product: p, origin } = result;
  const productTitle = p.title ?? p.slug;
  const title = isHouseCreator(creator)
    ? `${productTitle} · ${brand}`
    : `${productTitle} · ${creator.display_name} · ${brand}`;
  const description = (p.description ?? `A publication by ${creator.display_name} on ${brand}.`).slice(0, 155);
  const canonical = `${origin}/books/${creator.handle}/${product}`;
  return {
    robots: storefrontRobots([p]),
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", siteName: brand, title, description, url: canonical },
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
  const priceDisplay = formatProductPrice(price, p.currency, "—");
  const live = p.checkout_mode === "live";
  const title = p.title ?? productSlugOf(p);
  const buyUrl = `${PAY_ORIGIN}/checkout/${p.id}`;
  const layout = GLOBAL.storefront.product_layout;
  const overview =
    typeof p.overview === "string" && p.overview.trim() !== ""
      ? p.overview.trim()
      : p.overview === null
        ? null
        : resolveProductBookAssets(p).overview;
  const gridStyle = {
    "--product-cover-max-w": `${layout.cover_max_width_px}px`,
    "--product-cover-max-pct": `${layout.cover_max_width_pct}%`,
    "--product-gap-mobile": `${layout.gap_mobile_px}px`,
    "--product-gap-desktop": `${layout.gap_desktop_px}px`,
  } as CSSProperties;

  return (
    <BrandFrame>
      <header className="flex items-center justify-between">
        <BrandWordmark href={GLOBAL.storefront.b2c_landing_url} label="ExpanPress home" />
      </header>

      <main className="flex flex-col gap-6 md:gap-8">
        <div
          style={gridStyle}
          data-testid="product-hero-grid"
          className="grid grid-cols-1 gap-[var(--product-gap-mobile)] md:gap-[var(--product-gap-desktop)] md:grid-cols-[minmax(0,min(var(--product-cover-max-pct),var(--product-cover-max-w)))_minmax(0,1fr)] md:items-stretch"
        >
          <div
            data-testid="product-cover-col"
            className="w-full max-w-[var(--product-cover-max-w)] mx-auto md:max-w-none md:mx-0 md:h-full"
          >
            <BookCover
              title={title}
              coverImage={p.cover_image ?? null}
              isSample={p.is_sample ?? false}
              className="md:h-full"
            />
          </div>

          <section
            data-testid="product-details-card"
            className="glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8 flex flex-col gap-3.5 md:h-0 md:min-h-full"
          >
          <Link
            href={`/books/${creator.handle}`}
            className="shrink-0 self-start text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline underline-offset-4"
          >
            &larr; Back to {creator.display_name}&rsquo;s books
          </Link>

          <div className="shrink-0 flex flex-col gap-3">
            <p className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-600">
              Digital PDF &middot; Download link by email
            </p>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 leading-[1.12]">{title}</h1>
            <PublicationByline
              creatorHandle={creator.handle}
              creatorDisplayName={creator.display_name}
              creatorIsHouse={isHouseCreator(creator)}
              linkCreator
            />
            {isWorkingTitle(p) && (
              <p className="text-xs italic text-gray-600">
                Product shown under a working title &mdash; final title may change before publication.
              </p>
            )}
          </div>

          {p.description && <p className="shrink-0 text-base font-medium text-gray-800 leading-relaxed">{p.description}</p>}
          {overview && (
            <div
              tabIndex={0}
              role="region"
              aria-label="Book overview"
              data-testid="book-overview-scroll"
              className="md:flex-1 md:min-h-0 md:overflow-y-auto md:pr-2 md:pb-1 thin-scrollbar focus-visible:rounded-lg"
            >
              <p className="text-sm sm:text-base text-gray-700 leading-relaxed" data-testid="book-overview">
                {overview}
              </p>
            </div>
          )}

          <p className="shrink-0 text-2xl font-bold tracking-tight text-gray-900">
            {priceDisplay.formatted}{" "}
            <span className="text-xs font-normal text-gray-600">{`${priceDisplay.currency} · one-time`}</span>
          </p>

          {live ? (
            <BuyLink
              href={buyUrl}
              className="shrink-0"
              data-checkout-slot="primary"
              data-checkout-mode="live"
            >
              Buy now &mdash; secure checkout
              <ArrowIcon />
            </BuyLink>
          ) : (
            <p
              className="shrink-0 self-start rounded-full border border-[#dcc7b4] bg-white/60 px-6 py-3.5 text-sm font-semibold text-gray-700"
              aria-disabled="true"
              data-checkout-slot="primary"
              data-checkout-mode="gated"
            >
              Coming soon &mdash; not yet available for purchase
            </p>
          )}

          <p className="shrink-0 text-xs text-gray-600">Secure checkout hosted by our payment partners &middot; A download link is emailed after purchase</p>
          <p className="shrink-0 text-xs text-gray-600">Sales tax / VAT is calculated and collected at checkout by our payment partners.</p>

          {(p.disclaimers ?? []).map((d, i) => (
            <p key={i} className="shrink-0 text-xs text-gray-600 leading-relaxed">
              {d}
            </p>
          ))}

          {p.preview_pdf && (
            <PreviewScrollCue
              targetId={layout.preview_section_id}
              label={layout.preview_cue_label}
              bounceDistancePx={layout.cue_bounce_distance_px}
              bounceDurationS={layout.cue_bounce_duration_s}
              bounceRepeatDelayS={layout.cue_bounce_repeat_delay_s}
            />
          )}
          </section>
        </div>

        {p.preview_pdf && (
          <BookPreviewer
            id={layout.preview_section_id}
            previewPdfUrl={p.preview_pdf}
            coverImageUrl={p.cover_image ?? null}
            bookTitle={title}
            settings={GLOBAL.book_preview}
          />
        )}
      </main>

      <StorefrontFooter showBuyerLegal={GLOBAL.storefront.always_show_buyer_legal || live} />
    </BrandFrame>
  );
}
