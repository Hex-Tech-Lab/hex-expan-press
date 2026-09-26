/**
 * process_billing_webhook.ts — Application use case: handle an inbound billing webhook
 *
 * Receives provider-agnostic BillingEvent from adapter layer.
 * Delegates to the ledger for persistence.
 * Knows nothing about Polar, Paddle, or any provider.
 * ADR: ADR-0049, ADR-0050
 */
import { PaymentProviderPort, SaleCompletedEvent, RefundIssuedEvent } from "../../domain/payments/payments.port.ts";
import { appendSale, appendRefund } from "../../../payments/src/ledger.ts";
import { computeSplit } from "../../../payments/src/split.ts";
import { effectiveCreatorSplitPct } from "../../../payments/src/terms.ts";
import { loadProductIndex } from "../../../payments/src/webhook_core.ts";

export interface ProcessWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export async function processBillingWebhookUseCase(
  req: ProcessWebhookRequest,
  adapters: PaymentProviderPort[]
): Promise<void> {
  // 1. Signature-based routing — identity established from cryptographic evidence, never URL
  let matchedAdapter: PaymentProviderPort | undefined;
  for (const adapter of adapters) {
    if (adapter.canHandleWebhook(req.headers, req.body)) {
      matchedAdapter = adapter;
      break;
    }
  }

  if (!matchedAdapter) {
    throw new Error("No payment provider configured to handle this webhook signature.");
  }

  // 2. Zod-enforced parse — strict SSOT shape validation
  const validation = await matchedAdapter.parseAndValidateWebhook(req.headers, req.body);

  if (!validation.isValid) {
    const err = new Error(`Webhook validation failed for ${matchedAdapter.providerName}: ${validation.error}`);
    (err as any).httpStatus = (validation as any).httpStatus;
    throw err;
  }

  const { event } = validation;

  // 3. Ignored events — return silently (controller replies 202)
  if (event.eventType === "ignored") {
    return;
  }

  // 4. Refund
  if (event.eventType === "refund_issued") {
    const e = event as RefundIssuedEvent;
    await appendRefund({
      provider: e.providerName as any,
      sale_id: e.saleId,
      ts: e.occurredAt
    });
    return;
  }

  // 5. Sale completed
  if (event.eventType === "sale_completed") {
    const e = event as SaleCompletedEvent;

    // 5a. Resolve product config to determine creator and split
    const cfg = loadProductIndex().get(e.productId);
    if (!cfg) throw new Error(`Unknown product_id: ${e.productId}`);

    // 5b. Compute split
    const creatorPct = effectiveCreatorSplitPct(cfg.creator_id, cfg.product_id, e.occurredAt);
    if (creatorPct === null) throw new Error(`Could not resolve split percentage for creator ${cfg.creator_id}`);

    const amountUsd = e.totalCents / 100; // Ledger still stores USD float — convert from canonical cents
    const split = computeSplit(amountUsd, creatorPct);

    // 5c. Append to ledger
    await appendSale({
      sale_id: e.saleId,
      provider: e.providerName as any,
      product_id: e.productId,
      amount_usd: amountUsd,
      ts: e.occurredAt,
      email_hash: e.buyerEmailHash,
      creator_id: cfg.creator_id,
      creator_split_pct: creatorPct,
      creator_split_usd: split.creator_split_usd,
      our_split_usd: split.our_split_usd,
      currency: cfg.currency,
      ...(e.attributionId ? { attribution_id: e.attributionId } : {})
    });
  }
}
