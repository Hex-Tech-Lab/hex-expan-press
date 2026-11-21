import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import { BuyerEmailStep } from "../../../src/components/storefront/buyer-email-step";
import {
  NOINDEX,
  PublicationByline,
  StorefrontFooter,
  fetchCheckoutProduct,
  formatProductPrice,
  isHouseCreator,
  isWorkingTitle,
  priceOf,
} from "../../../src/components/storefront/storefront";
import { ATTRIBUTION_KEYS } from "../../../src/lib/attribution";
import { buyerConsentText } from "../../../src/lib/buyer-email";
import { isPurchasableProduct } from "../../../src/lib/product-purchasable";
import { paddleOverlayConfig, paddleOverlayUsable } from "../../../src/lib/paddle-overlay-server";
import { GLOBAL, paymentProviderDisplayName } from "../../../../payments/src/settings_registry";

/**
 * Checkout page on pay.expanpress.com (ADR 0061). The only origin that starts a
 * payment. It is a real page, not a redirect, because reviewers check the domain
 * they approve. It names the product, the price and the merchant of record, and
 * it links to the legal pages. Below the Merchant of Record disclosure, live
 * products render the single-hop BuyerEmailStep form that opens the Paddle.js
 * overlay on this host (Option A) or POSTs to /api/billing/checkout (303 See
 * Other to the selected payment rail).
 * Attribution parameters are read server-side and passed as initialAttribution
 * so no-JS POST submissions retain attribution.
 *
 * Rendered on the B2B brand (BrandFrame, BrandWordmark, Tailwind), the same as the product page.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ productId: string }>;
}): Promise<Metadata> {
  const { productId } = await params;
  const brand = GLOBAL.storefront.brand_name;
  const found = await fetchCheckoutProduct(productId);
  if (!found) return { title: `Checkout · ${brand}`, robots: NOINDEX };
  const title = `Checkout: ${found.product.title ?? found.product.slug} · ${brand}`;
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
  const { creator, product: p, railProvider } = found;

  const sp = await searchParams;
  const initialAttribution: Record<string, string> = {};
  for (const key of Object.keys(ATTRIBUTION_KEYS)) {
    const v = sp[key];
    if (typeof v === "string" && v !== "") initialAttribution[key] = v;
  }
  const price = priceOf(p);
  const priceDisplay = formatProductPrice(price, p.currency, "—");
  const live = p.checkout_mode === "live";
  // No price means no buy form: the email step (which opens the overlay) is not rendered for an unpriced product.
  const purchasable = isPurchasableProduct(p);
  const brand = GLOBAL.storefront.brand_name;
  if (railProvider === null) {
    console.error("[checkout] no active enabled rail for product; no provider is named on the page", { productId });
  }
  // Name the merchant of record only for a real selected rail. With no rail there is no provider to name (the route 503s).
  const activeProvider = railProvider;
  const morName = activeProvider ? paymentProviderDisplayName(activeProvider) : null;
  const overlayCfg = paddleOverlayConfig();
  const hasPaddlePrice = typeof p.paddle_price_id === "string" && p.paddle_price_id.trim() !== "";
  // A purchasable (live and priced) Paddle checkout with a Paddle price: the only case where the overlay is attempted.
  // An unpriced product renders no buy form, so it attempts nothing (shared by the log and paddleClient).
  const paddleOverlayAttempted = purchasable && activeProvider === "paddle" && hasPaddlePrice;
  if (paddleOverlayAttempted && !overlayCfg.ok) {
    console.error("[checkout] paddle overlay unavailable; buyer gets the POST fallback", { productId, reason: overlayCfg.reason });
  }
  // The overlay config loads but its Paddle environment does not match this product's checkout mode: the buyer gets the POST fallback.
  if (paddleOverlayAttempted && overlayCfg.ok && !paddleOverlayUsable(overlayCfg.client, p.checkout_mode)) {
    console.error("[checkout] paddle overlay environment does not match checkout mode; buyer gets the POST fallback", { productId, checkoutMode: p.checkout_mode });
  }
  const paddleClient =
    paddleOverlayAttempted &&
    overlayCfg.ok &&
    paddleOverlayUsable(overlayCfg.client, p.checkout_mode)
      ? overlayCfg.client
      : null;

  return (
    <BrandFrame>
      <header className="flex items-center justify-between">
        <BrandWordmark href={GLOBAL.storefront.b2c_landing_url} label={`${brand} home`} />
      </header>

      <main className="glass-card card-shadow mx-auto w-full max-w-xl rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8 flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <p className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-600">
            {`Secure checkout · ${brand}`}
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 leading-[1.12]">{p.title ?? p.slug}</h1>
          <PublicationByline creatorHandle={creator.handle} creatorDisplayName={creator.display_name} creatorIsHouse={isHouseCreator(creator)} />
          {isWorkingTitle(p) && (
            <p className="text-xs italic text-gray-600">Product shown under a working title &mdash; final title may change before publication.</p>
          )}
        </div>

        {p.description && <p className="text-base text-gray-700 leading-relaxed">{p.description}</p>}

        <p className="text-2xl font-bold tracking-tight text-gray-900">
          {priceDisplay.formatted}{" "}
          <span className="text-xs font-normal text-gray-600">{`${priceDisplay.currency} · one-time`}</span>
        </p>

        {morName && (
          <p className="text-xs text-gray-600 leading-relaxed">
            {`Your order is processed by ${morName}, which acts as Merchant of Record. Sales tax and VAT are calculated and collected at checkout.`}
          </p>
        )}

        {purchasable ? (
          <BuyerEmailStep
            action="/api/billing/checkout"
            productId={p.id}
            domains={[...GLOBAL.email_address.typo_domains]}
            maxEmailLength={GLOBAL.email_address.max_length}
            consentText={buyerConsentText(GLOBAL.delivery.buyer_typical_minutes, GLOBAL.delivery.buyer_support_after_hours, GLOBAL.email.support)}
            initialAttribution={initialAttribution}
            paddleClient={paddleClient}
          />
        ) : (
          <p
            className="self-start rounded-full border border-[#dcc7b4] bg-white/60 px-6 py-3.5 text-sm font-semibold text-gray-700"
            aria-disabled="true"
            data-checkout-slot="primary"
            data-checkout-mode={live ? "unpriced" : "gated"}
          >
            Coming soon &mdash; not yet available for purchase
          </p>
        )}

        <p className="text-xs text-gray-600">A download link is emailed after purchase</p>
      </main>

      {/* Buyer legal links always show when storefront.always_show_buyer_legal is enabled (KYC requirement). */}
      <StorefrontFooter showBuyerLegal={GLOBAL.storefront.always_show_buyer_legal || live} />
    </BrandFrame>
  );
}
