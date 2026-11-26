import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaddleTransactionCheckout } from "../../src/components/billing/paddle-transaction-checkout";
import { parseTransactionId } from "../../src/lib/paddle-transaction-id";

/**
 * Paddle default checkout page on pay.expanpress.com (ADR 0061). Paddle sends the
 * buyer here as `/checkout?_ptxn=txn_...`. Without a valid transaction id the page
 * is a 404, so the path reveals nothing on its own. Robots are blocked because the
 * page only works with a transaction that Paddle created.
 */

const NOINDEX = { index: false, follow: false } as const;

export const metadata: Metadata = {
  title: "Checkout · ExpanPress",
  robots: NOINDEX,
};

export default async function TransactionCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const transactionId = parseTransactionId((await searchParams)._ptxn);
  if (transactionId === null) notFound();
  return (
    <main>
      <PaddleTransactionCheckout transactionId={transactionId} />
    </main>
  );
}
