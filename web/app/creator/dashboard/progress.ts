export interface ReviewProgress {
  answered: number;
  total: number;
}

/**
 * Distinct-item answer counting: re-answers append history rows, so a
 * plain row count inflates progress. Counted = distinct item_ids among
 * answers that belong to the product's review items.
 */
export function reviewProgress(itemIds: string[], answeredItemIds: string[]): ReviewProgress {
  const items = new Set(itemIds);
  const answered = new Set<string>();
  for (const id of answeredItemIds) {
    if (items.has(id)) answered.add(id);
  }
  return { answered: answered.size, total: items.size };
}
