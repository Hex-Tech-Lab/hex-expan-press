// Page of a review question in the book (review_items.anchor). Null when unknown.
// Null is a gate, not a default: the review page must not highlight page 1 for an unanchored question.
import { z } from "zod";

const pageSchema = z.number().int().positive();

export function anchorPageOf(anchor: unknown): number | null {
  if (!anchor || typeof anchor !== "object") return null;
  const a = anchor as { page?: unknown; touchpoints?: unknown };
  const first = Array.isArray(a.touchpoints) ? (a.touchpoints[0] as { page?: unknown } | undefined) : undefined;
  const parsed = pageSchema.safeParse(first?.page ?? a.page);
  return parsed.success ? parsed.data : null;
}
