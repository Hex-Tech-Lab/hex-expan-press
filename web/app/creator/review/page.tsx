import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { naturalCode } from "../../../src/lib/natural-code";
import { getPortalSession } from "../../../src/lib/supabase-server";
import { resolvePrimaryProduct } from "../../../src/lib/primary-product";
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

  const [productRes, itemsRes, answersRes] = await Promise.all([
    resolvePrimaryProduct<{ id: string; slug: string; title: string; release_path: string | null }>(
      supabase,
      "id, slug, title, release_path",
    ),
    supabase.from("review_items").select("id, code, kind, question, options, anchor, product_id"),
    supabase.from("review_answers").select("item_id, choice, free_text, answered_at").order("answered_at", { ascending: false }),
  ]);

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

  const allItems = (itemsRes.data ?? [])
    .filter((it) => it.product_id === product.id)
    .sort((a, b) => naturalCode(a.code, b.code));

  if (itemsRes.error || allItems.length === 0) {
    return (
      <ReviewNotice
        title={itemsRes.error ? "We couldn't load your review items." : "No review items yet."}
        body="Please reload in a moment, or contact support@expanpress.com if this persists."
      />
    );
  }

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

  // Short-lived signed URL for the private review PDF (server-side, RLS).
  let pdfUrl: string | null = null;
  if (product.release_path) {
    try {
      const { data } = await supabase.storage.from("review-pdfs").createSignedUrl(product.release_path, 3600);
      pdfUrl = data?.signedUrl ?? null;
    } catch (err) {
      console.error("[review] signed URL creation failed:", err);
    }
  }

  const items: ReviewItemView[] = allItems.map((it) => {
    const anchor = (it.anchor ?? null) as { page?: number; touchpoints?: { page?: number }[] } | null;
    const anchorPage = anchor?.touchpoints?.[0]?.page ?? anchor?.page ?? null;
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
    />
  );
}

function ReviewNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-[680px] px-5 py-16" role="alert">
      <h1 className="font-serif text-[length:var(--text-heading-1-size)] font-bold text-[#2B2520]">{title}</h1>
      <p className="mt-2 text-[length:var(--font-size-base)] text-[#6E5F53]">{body}</p>
      <a
        href="/creator/dashboard"
        className="mt-5 inline-block rounded-lg border border-[#EADFD1] px-4 py-2 text-[length:var(--font-size-sm)] font-semibold text-[#6E5F53] hover:bg-[#F3ECDF]"
      >
        Back to dashboard
      </a>
    </div>
  );
}
