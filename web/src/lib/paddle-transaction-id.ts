/**
 * Paddle transaction id from the `_ptxn` query parameter of the pay-host checkout
 * page. Paddle issues ids as `txn_` followed by a lowercase base32-style suffix.
 * Anything else is refused, so the id is never trusted as free text.
 */
const TRANSACTION_ID = /^txn_[0-9a-z]{20,40}$/;

export function parseTransactionId(raw: string | string[] | undefined): string | null {
  if (typeof raw !== "string") return null;
  return TRANSACTION_ID.test(raw) ? raw : null;
}
