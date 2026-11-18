// Page of a review question in the book (review_items.anchor). Null when unknown.
// Null is a gate, not a default: the review page must not highlight page 1 for an unanchored question.
import { z } from "zod";

const pageSchema = z.number().int().positive();

export function anchorPageOf(anchor: unknown): number | null {
  if (!anchor || typeof anchor !== "object") return null;
  const a = anchor as { page?: unknown; touchpoints?: unknown };
  // A malformed first touchpoint must not mask a valid top-level page: parse the touchpoint first and
  // fall back to `page` whenever the touchpoint does not parse (not only when it is nullish).
  const first = Array.isArray(a.touchpoints) ? (a.touchpoints[0] as { page?: unknown } | undefined) : undefined;
  const fromTouchpoint = pageSchema.safeParse(first?.page);
  if (fromTouchpoint.success) return fromTouchpoint.data;
  const fromPage = pageSchema.safeParse(a.page);
  return fromPage.success ? fromPage.data : null;
}

/** Where the viewer opens for an anchor in a PDF of `numPages` pages.
 *  A null anchor opens page 1 with no notice (the caller decides whether that is a gate).
 *  An anchor outside the PDF still opens page 1 (page 0 renders nothing), and the notice says so: the creator is told, not shown page 1 silently. */
export function viewerPageFor(anchor: number | null, numPages: number, code: string): { page: number; notice: string | null } {
  if (anchor === null) return { page: 1, notice: null };
  if (anchor >= 1 && anchor <= numPages) return { page: anchor, notice: null };
  return {
    page: 1,
    notice: `Question ${code} points to PDF page ${anchor}, but this PDF has ${numPages} pages. Showing page 1.`,
  };
}
