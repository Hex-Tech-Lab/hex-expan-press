import type { Metadata } from "next";
import Link from "next/link";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import { BrandFrame, BrandWordmark } from "../../../../src/components/brand/brand";
import { NOINDEX, StorefrontFooter, fetchCreatorHub, resolveCreatorOr404 } from "../../../../src/components/storefront/storefront";

/**
 * Thank-you return page. Checkout sends the buyer here (success URL = /books/{handle}/thanks).
 * The logo goes to the B2C landing (registry storefront.b2c_landing_url). The back link goes to the
 * creator's books (/books/{handle}). The support address comes from the registry (email.reply_to).
 * Never indexed.
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
  const support = GLOBAL.email.reply_to;

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
              {`It is sent to the email you used at checkout. If it does not arrive, check your spam folder or contact ${support}.`}
            </p>
            <Link
              href={`/books/${creator.handle}`}
              className="group mt-8 inline-flex items-center gap-4 text-sm font-semibold text-white hover:text-peach transition-colors"
            >
              <span>{`Back to ${creator.display_name}'s books`}</span>
              <span className="group-hover:translate-x-1 transition-transform">&rarr;</span>
            </Link>
          </div>
        </section>
      </main>

      <StorefrontFooter />
    </BrandFrame>
  );
}
