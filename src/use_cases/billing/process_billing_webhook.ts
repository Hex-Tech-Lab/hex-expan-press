/**
 * process_billing_webhook.ts — Application use case: handle an inbound billing webhook
 *
 * Receives provider-agnostic BillingEvent from adapter layer.
 * Delegates to the ledger for persistence.
 * Knows nothing about Polar, Paddle, or any provider.
 * ADR: ADR-0049, ADR-0050
 */
import { PaymentProviderPort, SaleCompletedEvent, RefundIssuedEvent } from "../../domain/payments/payments.port.ts";
import { appendSale, appendRefund, findSaleAsync, findRefundAsync } from "../../../payments/src/ledger.ts";
import { computeSplit } from "../../../payments/src/split.ts";
import { effectiveCreatorSplitPct } from "../../../payments/src/terms.ts";
import { loadProductIndex, withIdempotencyLock } from "../../../payments/src/webhook_core.ts";

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

  // 4. Refund — wrapped in the distributed idempotency lock (refund events only carry
  // sale_id — no refund id exists to key on). Lock held or duplicate → return normally.
  if (event.eventType === "refund_issued") {
    const refundEvent = event as RefundIssuedEvent;
    await withIdempotencyLock(
      `refund:${refundEvent.providerName}:${refundEvent.saleId}`,
      { status: 200, payload: { ok: true, recorded: false, reason: "duplicate-or-inflight", event_type: "refund", sale_id: refundEvent.saleId } },
      async () => {
        const existingRefund = await findRefundAsync(refundEvent.providerName, refundEvent.saleId);
        if (existingRefund) {
          return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", event_type: "refund", sale_id: refundEvent.saleId } };
        }
        await appendRefund({
          provider: refundEvent.providerName as any,
          sale_id: refundEvent.saleId,
          ts: refundEvent.occurredAt
        });
        return { status: 200, payload: { ok: true, recorded: true, event_type: "refund", sale_id: refundEvent.saleId } };
      },
    );
    return;
  }

  // 5. Sale completed
  if (event.eventType === "sale_completed") {
    const saleEvent = event as SaleCompletedEvent;

    // 5a. Distributed idempotency lock: concurrent/duplicate deliveries for the same sale
    // take the lock; a held lock or already-recorded sale → return normally (no double payout).
    // withIdempotencyLock also frees the slot when nothing was written (payload.recorded !== true).
    await withIdempotencyLock(
      `sale:${saleEvent.providerName}:${saleEvent.saleId}`,
      { status: 200, payload: { ok: true, recorded: false, reason: "duplicate-or-inflight", sale_id: saleEvent.saleId } },
      async () => {
        // Duplicate guard: if sale already recorded, exit early without duplicating splits
        const existing = await findSaleAsync(saleEvent.providerName, saleEvent.saleId);
        if (existing) {
          return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", sale_id: saleEvent.saleId } };
        }

        // Resolve product config to determine creator and split
        const cfg = loadProductIndex().get(saleEvent.productId);
        if (!cfg) throw new Error(`Unknown product_id: ${saleEvent.productId}`);

        // Compute split
        const creatorPct = effectiveCreatorSplitPct(cfg.creator_id, cfg.product_id, saleEvent.occurredAt);
        if (creatorPct === null) throw new Error(`Could not resolve split percentage for creator ${cfg.creator_id}`);

        const amountUsd = saleEvent.totalCents / 100; // Ledger still stores USD float — convert from canonical cents
        const split = computeSplit(amountUsd, creatorPct);

        // Append to ledger
        await appendSale({
          sale_id: saleEvent.saleId,
          provider: saleEvent.providerName as any,
          product_id: saleEvent.productId,
          amount_usd: amountUsd,
          ts: saleEvent.occurredAt,
          email_hash: saleEvent.buyerEmailHash,
          creator_id: cfg.creator_id,
          creator_split_pct: creatorPct,
          creator_split_usd: split.creator_split_usd,
          our_split_usd: split.our_split_usd,
          currency: cfg.currency,
          ...(saleEvent.attributionId ? { attribution_id: saleEvent.attributionId } : {})
        });
        return { status: 200, payload: { ok: true, recorded: true, sale_id: saleEvent.saleId } };
      },
    );
  }
}
