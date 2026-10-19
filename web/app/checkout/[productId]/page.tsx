import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyLink } from "../../../src/components/storefront/buy-link";
import {
  NOINDEX,
  StorefrontFooter,
  fetchCheckoutProduct,
  isWorkingTitle,
  priceOf,
} from "../../../src/components/storefront/storefront";
import { ATTRIBUTION_KEYS } from "../../../src/lib/attribution";

/**
 * Checkout page on pay.expanpress.com (ADR 0061). The only origin that starts a
 * payment. It is a real page, not a redirect, because reviewers check the domain
 * they approve. It names the product, the price and the merchant of record, and
 * it links to the legal pages. The Buy button goes to the existing checkout
 * route, which enforces consent and picks the rail. Attribution parameters are
 * forwarded so the route can record them.
 */
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ productId: string }>;
}): Promise<Metadata> {
  const { productId } = await params;
  const found = await fetchCheckoutProduct(productId);
  if (!found) return { title: "Checkout · ExpanPress", robots: NOINDEX };
  const title = `Checkout: ${found.product.title ?? found.product.composite_slug} · ExpanPress`;
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

  return (
    <div className="sf-root">
      <div className="wrap">
        <p className="kicker">Secure checkout &middot; ExpanPress</p>
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
        <p className="taxnote">
          Your order is processed by Paddle.com, and others as enabled, which act as Merchant of Record. Sales tax and VAT are
          calculated and collected at checkout.
        </p>

        {p.checkout_mode === "live" ? (
          <BuyLink className="buybtn" href={buyHref}>
            Buy now &mdash; secure checkout
          </BuyLink>
        ) : (
          <p className="buybtn buybtn-gated" aria-disabled="true">
            Coming soon &mdash; not yet available for purchase
          </p>
        )}
        <p className="assurance">A download link is emailed after purchase</p>

        <StorefrontFooter />
      </div>
    </div>
  );
}
