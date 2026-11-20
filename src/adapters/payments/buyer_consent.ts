// Shared buyer-consent parser for every webhook adapter. Paddle reads custom_data (string "true"/"false"), Creem reads
// metadata (boolean or string). One rule set, so a provider cannot quietly accept a value another provider refuses.

/**
 * Buyer consent from a provider payload: a boolean or the exact strings "true"/"false". Anything else is absent (undefined),
 * which the order stores as NULL. A non-null malformed value is logged. The value is buyer-supplied: recorded, never a decision.
 */
export function parseBuyerConsent(raw: unknown, context: { key: string; transactionId?: string }): boolean | undefined {
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  if (raw !== undefined && raw !== null) {
    const tx = context.transactionId ? ` transaction_id=${context.transactionId}` : "";
    console.warn(`[buyer-consent] ignoring non-boolean ${context.key} value (type=${typeof raw})${tx}; storing NULL`);
  }
  return undefined;
}
