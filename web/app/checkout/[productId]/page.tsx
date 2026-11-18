import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyLink } from "../../../src/components/storefront/buy-link";
import { ArrowIcon, BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import {
  NOINDEX,
  StorefrontFooter,
  fetchCheckoutProduct,
  isWorkingTitle,
  priceOf,
} from "../../../src/components/storefront/storefront";
import { ATTRIBUTION_KEYS } from "../../../src/lib/attribution";
import { GLOBAL } from "../../../../payments/src/settings_registry";

/**
 * Checkout page on pay.expanpress.com (ADR 0061). The only origin that starts a
 * payment. It is a real page, not a redirect, because reviewers check the domain
 * they approve. It names the product, the price and the merchant of record, and
 * it links to the legal pages. The Buy button goes to the existing checkout
 * route, which enforces consent and picks the rail. Attribution parameters are
 * forwarded so the route can record them (awaiting searchParams makes the route
 * dynamic per request).
 *
 * Rendered on the B2B brand (BrandFrame, BrandWordmark, Tailwind), the same as the product page.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ productId: string }>;
}): Promise<Metadata> {
  const { productId } = await params;
  const found = await fetchCheckoutProduct(productId);
  if (!found) return { title: "Checkout · ExpanPress", robots: NOINDEX };
  const title = `Checkout: ${found.product.title ?? found.product.slug} · ExpanPress`;
  return { title, robots: NOINDEX };
}

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { productId } = await params;
  const found = await fetchCheckoutProduct(productId);
  if (!found) notFound();
  const { creator, product: p } = found;

  const sp = await searchParams;
  const qs = new URLSearchParams({ product: p.id });
  for (const key of Object.keys(ATTRIBUTION_KEYS)) {
    const v = sp[key];
    if (typeof v === "string" && v !== "") qs.set(key, v);
  }
  const buyHref = `/api/billing/checkout?${qs.toString()}`;
  const price = priceOf(p);
  const live = p.checkout_mode === "live";

  return (
    <BrandFrame>
      <header className="flex items-center justify-between">
        <BrandWordmark href={GLOBAL.storefront.b2c_landing_url} label="ExpanPress home" />
      </header>

      <main className="glass-card card-shadow mx-auto w-full max-w-xl rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8 flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <p className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-600">
            Secure checkout &middot; ExpanPress
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 leading-[1.12]">{p.title ?? p.slug}</h1>
          <p className="text-sm text-gray-600">
            A creator-collaboration publication &middot; with{" "}
            <span className="font-medium text-gray-800">{creator.display_name}</span>
          </p>
          {isWorkingTitle(p) && (
            <p className="text-xs italic text-gray-600">Product shown under a working title &mdash; final title may change before publication.</p>
          )}
        </div>

        {p.description && <p className="text-base text-gray-700 leading-relaxed">{p.description}</p>}

        <p className="text-2xl font-bold tracking-tight text-gray-900">
          {price !== null ? `$${price.toFixed(2)}` : "—"}{" "}
          <span className="text-xs font-normal text-gray-600">{`${p.currency ?? "USD"} · one-time`}</span>
        </p>

        <p className="text-xs text-gray-600 leading-relaxed">
          Your order is processed by Paddle.com, and others as enabled, which act as Merchant of Record. Sales tax and VAT are
          calculated and collected at checkout.
        </p>

        {live ? (
          <BuyLink
            className="self-start inline-flex items-center gap-3 rounded-full bg-[#2A2A2A] hover:bg-[#383838] text-white px-6 py-3.5 text-sm font-semibold transition-colors"
            href={buyHref}
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

        <p className="text-xs text-gray-600">A download link is emailed after purchase</p>
      </main>

      {/* A gated (draft) product hides the buyer legal links, the same rule as the product page. */}
      <StorefrontFooter showBuyerLegal={live} />
    </BrandFrame>
  );
}
