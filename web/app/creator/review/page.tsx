import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { naturalCode } from "../../../src/lib/natural-code";
import { anchorPageOf } from "../../../src/lib/review-anchor";
import { getPortalSession } from "../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
import { BrandButton, BrandFooter, BrandFrame, BrandWordmark } from "../../../src/components/brand/brand";
import ReviewClient from "./review-client";

export const metadata: Metadata = {
  title: "Manuscript Review · ExpanPress",
  robots: { index: false, follow: false }, // authenticated surface
};


export interface ReviewItemView {
  id: string;
  code: string;
  kind: string;
  question: string;
  options: { key: string; label: string }[];
  anchorPage: number | null;
}

/**
 * Manuscript review (Wave 6.1, RSC — replaces the orphaned legacy static
 * page whose localStorage-token auth broke in Wave 5). The session is the
 * ssr HttpOnly cookie (fail-closed server redirect); every read runs under
 * the caller's RLS identity: their product, its review items, their own
 * saved answers. The private review PDF is exposed only as a short-lived
 * signed URL created server-side from product.release_path.
 */
export default async function ReviewPage() {
  const session = await getPortalSession();
  if (!session) {
    redirect("/creator/signin");
  }
  const { supabase } = session;

  const productRes = await resolvePrimaryProduct<{ id: string; slug: string; title: string; release_path: string | null }>(
    supabase,
    "id, slug, title, release_path",
  );

  const product = productRes.product;
  if (productRes.error || !product) {
    return (
      <ReviewNotice
        title={productRes.error ? "We couldn't load your review." : "No review assigned to your account yet."}
        body={
          productRes.error
            ? "This looks like a temporary problem on our side — your work is safe. Please reload in a moment."
            : "Once your manuscript review is prepared, it will appear here."
        }
      />
    );
  }

  const itemsRes = await supabase
    .from("review_items")
    .select("id, code, kind, question, options, anchor, product_id")
    .eq("product_id", product.id)
    .order("code", { ascending: true })
    .limit(500);

  const sortedItems = (itemsRes.data ?? []).sort((a, b) => naturalCode(a.code, b.code));
  // Gate: a question with no page anchor used to highlight page 1. Serve only anchored questions.
  const allItems = sortedItems.filter((it) => anchorPageOf(it.anchor) !== null);

  if (itemsRes.error || sortedItems.length === 0) {
    return (
      <ReviewNotice
        title={itemsRes.error ? "We couldn't load your review items." : "No review items yet."}
        body={`Please reload in a moment, or contact ${GLOBAL.email.support} if this persists.`}
      />
    );
  }
  if (allItems.length === 0) {
    return (
      <ReviewNotice
        title="Your review questions are being checked."
        body="Each question is shown only once it points to its page in your book. Nothing is missing from your work."
      />
    );
  }

  const itemIds = allItems.map((it) => it.id);
  const [answersRes, pdfUrl] = await Promise.all([
    supabase
      .from("review_answers")
      .select("item_id, choice, free_text, answered_at")
      .in("item_id", itemIds)
      .order("answered_at", { ascending: false })
      .limit(500),
    // Short-lived signed URL for the private review PDF (server-side, RLS).
    (async (): Promise<string | null> => {
      if (!product.release_path) return null;
      try {
        const { data } = await supabase.storage.from("review-pdfs").createSignedUrl(product.release_path, 3600);
        return data?.signedUrl ?? null;
      } catch (err) {
        console.error("[review] signed URL creation failed:", err);
        return null;
      }
    })(),
  ]);

  // A failed answers read must not look like "nothing answered yet".
  if (answersRes.error) {
    return (
      <ReviewNotice
        title="We couldn't load your saved answers."
        body="Your work is safe — please reload in a moment."
      />
    );
  }

  // First hit per item = most recent answer (resume parity with legacy).
  const saved = new Map<string, { choice: string | null; freeText: string | null }>();
  for (const a of answersRes.data ?? []) {
    if (!saved.has(a.item_id)) saved.set(a.item_id, { choice: a.choice, freeText: a.free_text });
  }

  const items: ReviewItemView[] = allItems.map((it) => {
    const anchorPage = anchorPageOf(it.anchor);
    return {
      id: it.id,
      code: it.code,
      kind: it.kind,
      question: it.question,
      options: Array.isArray(it.options) ? (it.options as { key: string; label: string }[]) : [],
      anchorPage,
    };
  });

  return (
    <ReviewClient
      items={items}
      saved={Object.fromEntries(saved)}
      pdfUrl={pdfUrl}
      bookTitle={product.title}
      supportEmail={GLOBAL.email.support}
    />
  );
}

function ReviewNotice({ title, body }: { title: string; body: string }) {
  return (
    <BrandFrame outerClassName="justify-between">
      <header className="flex items-center justify-between">
        <BrandWordmark href="/creator/dashboard" label="Creator dashboard" />
      </header>
      <main className="mx-auto w-full max-w-[680px] glass-card card-shadow rounded-[32px] border-[1.5px] border-[#fff2e4] p-6 sm:p-8" role="alert">
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        <p className="mt-2 text-base text-gray-700">{body}</p>
        <BrandButton variant="secondary" href="/creator/dashboard" className="mt-5 px-4 py-2">
          Back to dashboard
        </BrandButton>
      </main>
      <BrandFooter>
        <a href="/privacy.html" className="hover:text-gray-700 transition-colors">Privacy Policy</a>
        <a href="/terms.html" className="hover:text-gray-700 transition-colors">Terms of Service</a>
        <span>{GLOBAL.email.support}</span>
      </BrandFooter>
    </BrandFrame>
  );
}
