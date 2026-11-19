import type { Metadata } from "next";
import Link from "next/link";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { BrandFrame, BrandWordmark } from "../../../../src/components/brand/brand";
import {
  NOINDEX,
  StorefrontFooter,
  fetchCreatorHub,
  isHouseCreator,
  resolveCreatorOr404,
} from "../../../../src/components/storefront/storefront";
import { buyerDeliveryPromiseText } from "../../../../src/lib/buyer-email";

/**
 * Thank-you return page. Checkout sends the buyer here (success URL = /books/{handle}/thanks).
 * The logo goes to the B2C landing (registry storefront.b2c_landing_url). The back link goes to the
 * creator's books (/books/{handle}). The delivery promise and support address come from the registry.
 * Never indexed.
 */
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const brand = GLOBAL.storefront.brand_name;
  const result = await fetchCreatorHub(handle);
  const title =
    result && !isHouseCreator(result.creator.display_name, brand)
      ? `Thank you · ${result.creator.display_name} · ${brand}`
      : `Thank you · ${brand}`;
  return { title, robots: NOINDEX };
}

export default async function ThankYouPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const { creator } = resolveCreatorOr404(await fetchCreatorHub(handle));
  const body = buyerDeliveryPromiseText(
    GLOBAL.delivery.buyer_typical_minutes,
    GLOBAL.delivery.buyer_support_after_hours,
    GLOBAL.email.reply_to,
  );

  return (
    <BrandFrame>
      <header className="flex items-center justify-between">
        <BrandWordmark href={GLOBAL.storefront.b2c_landing_url} label="ExpanPress home" />
      </header>

      <main>
        <section className="relative overflow-hidden rounded-[32px] bg-charcoal text-white p-8 sm:p-10 md:p-12">
          <div aria-hidden="true" className="absolute -right-10 bottom-10 w-28 h-56 rounded-full bg-peach/10 blur-3xl pointer-events-none" />
          <div className="relative max-w-xl">
            <p className="text-[11px] sm:text-xs font-mono font-medium tracking-[0.16em] uppercase text-gray-400 mb-6">
              Purchase complete
            </p>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-white leading-[1.12]">
              Thank you, your download link is on its way by email
            </h1>
            <p className="mt-5 text-sm sm:text-base text-gray-300 leading-relaxed">
              {body}
            </p>
            <Link
              href={`/books/${creator.handle}`}
              className="group mt-8 inline-flex items-center gap-4 text-sm font-semibold text-white hover:text-peach transition-colors"
            >
              <span>{`Back to ${creator.display_name}\u2019s books`}</span>
              <span className="group-hover:translate-x-1 transition-transform">&rarr;</span>
            </Link>
          </div>
        </section>
      </main>

      <StorefrontFooter />
    </BrandFrame>
  );
}
