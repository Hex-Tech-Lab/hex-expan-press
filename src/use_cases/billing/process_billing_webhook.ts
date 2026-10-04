/**
 * process_billing_webhook.ts — Application use case: handle an inbound billing webhook
 *
 * Receives provider-agnostic BillingEvent from adapter layer.
 * Delegates to the ledger for persistence.
 * Knows nothing about Polar, Paddle, or any provider.
 * ADR: ADR-0049, ADR-0050
 */
import { PaymentProviderPort, SaleCompletedEvent, RefundIssuedEvent, RefundReversedEvent } from "../../domain/payments/payments.port.ts";
import { appendSale, appendRefund, appendRefundReversal, findSaleAsync, findRefundAsync, findRefundReversalAsync, findByProviderAdjustmentIdAsync, flagRefundForManualReview, isAdjustmentIdUniqueViolation } from "../../../payments/src/ledger.ts";
import { computeSplit } from "../../../payments/src/split.ts";
import { effectiveCreatorSplitPct } from "../../../payments/src/terms.ts";
import { loadProductIndex, withIdempotencyLock, WebhookInFlightError } from "../../../payments/src/webhook_core.ts";
import { GLOBAL } from "../../../payments/src/settings_registry.ts";

type LockedFn = () => Promise<{ status: number; payload: Record<string, unknown> }>;

/**
 * 23505 on orders_provider_adjustment_id_uniq: a concurrent delivery won the
 * index — but only a conflicting row that MATCHES this event (same sale,
 * same amount, same currency) is a genuine replay worth acknowledging 200.
 * Anything else is a real collision: flag it for manual review (best-effort;
 * a flag-write failure must never soften this into a 200) and throw a 503 so
 * the provider retries while ops investigates.
 */
async function resolveAdjustmentIdCollision(
  provider: string,
  adjustmentId: string,
  eventType: "refund" | "refund_reversal",
  event: { saleId: string; totalCents?: number; currency?: string },
  flag: {
    refundId: string | null;
    refundCents: number | null;
    occurredAt: string;
  },
): Promise<{ status: 200; payload: Record<string, unknown> }> {
  let row: Awaited<ReturnType<typeof findByProviderAdjustmentIdAsync>> | null = null;
  try {
    row = await findByProviderAdjustmentIdAsync(provider, adjustmentId, eventType);
  } catch (lookupErr) {
    console.error("[billing-webhook] collision-adjustment lookup failed:", lookupErr);
    throw Object.assign(new Error(`Webhook retryable: adjustment-id collision lookup failed for ${eventType} ${adjustmentId}`), { httpStatus: 503 });
  }
  if (!row) {
    throw Object.assign(new Error(`Webhook retryable: adjustment-id collision with no recoverable row for ${eventType} ${adjustmentId}`), { httpStatus: 503 });
  }
  const matches =
    row.sale_id === event.saleId &&
    (event.totalCents === undefined || Math.round(row.amount_usd * 100) === event.totalCents) &&
    (event.currency === undefined || row.currency.toUpperCase() === event.currency.toUpperCase());
  if (matches) {
    return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", dedupe: "provider_adjustment_id", event_type: eventType, sale_id: event.saleId } };
  }
  // Mismatch: durable flag first. A flag-write failure must propagate (throw),
  // never be swallowed into a 200 acknowledgement.
  await flagRefundForManualReview({
    reason: "adjustment_id_collision",
    provider,
    sale_id: event.saleId,
    refund_id: flag.refundId,
    refund_cents: flag.refundCents,
    sale_cents: Math.round(row.amount_usd * 100),
    creator_id: row.creator_id ?? null,
    occurred_at: flag.occurredAt,
  });
  throw Object.assign(
    new Error(
      `Webhook retryable: adjustment-id collision for ${eventType} ${adjustmentId} — conflicting row does not match this event (sale/amount/currency)`,
    ),
    { httpStatus: 503 },
  );
}

/**
 * Run fn under the idempotency lock. A held lock is NOT success — the holder may
 * still fail. Acknowledge only when the record is confirmed durable; otherwise
 * rethrow WebhookInFlightError so the route answers 503 and the provider retries.
 */
async function underLockOrConfirmed(lockKey: string, isPersisted: () => Promise<boolean>, fn: LockedFn): Promise<void> {
  try {
    await withIdempotencyLock(lockKey, fn);
  } catch (err) {
    if (err instanceof WebhookInFlightError && (await isPersisted())) return;
    throw err;
  }
}

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
    const err = new Error(`Webhook validation failed for ${matchedAdapter.providerName}: ${validation.error}`) as Error & { httpStatus?: number };
    err.httpStatus = validation.httpStatus;
    throw err;
  }

  const { event } = validation;

  // 3. Ignored events — return silently (controller replies 202)
  if (event.eventType === "ignored") {
    return;
  }

  // 4. Refund — every check runs INSIDE the idempotency lock (keyed on sale_id), so
  // the sale lookup, amount validation and write see one consistent state (no
  // check-then-lock TOCTOU window).
  //
  // REFUND CONTRACT (ADR-0050/0057): refunds are FULL REVERSALS only — one refund
  // per sale, stored as the negated split of the original sale.
  //  - totalCents present: must EQUAL the original sale amount exactly. Partial and
  //    over-refunds are flagged durably (audit_log MANUAL_REVIEW_REQUIRED_REFUND)
  //    and rejected with a validation failure (400).
  //  - totalCents absent: the adapter's provider does not report a refund amount
  //    (Polar sends it; Payhip-style legacy providers do not) — treated as a full
  //    reversal of the linked sale.
  //  - amountUnverifiable: the provider reports no refunded amount at all (Fungies
  //    payment_refunded carries none). The refund is NEVER recorded; it is flagged
  //    durably (audit_log MANUAL_REVIEW_REQUIRED_REFUND, reason "amount_unverifiable")
  //    and rejected with a validation failure (400) for manual review.
  if (event.eventType === "refund_issued") {
    const refundEvent = event as RefundIssuedEvent;
    await underLockOrConfirmed(
      `lock:refund:${refundEvent.providerName}:${refundEvent.saleId}`,
      // Confirm a contended refund only when THIS delivery would itself pass the in-lock checks
      // (verifiable amount equal to the sale, same currency), in the same order as in-lock: a
      // partial/over/foreign-currency refund retries and gets flagged inside. Then either the refund
      // row carrying this adjustment id proves it was handled (also after a won dispute), or, with no
      // adjustment id match, the sale must still be refunded and not yet reversed.
      async () => {
        if (refundEvent.amountUnverifiable === true) return false; // absent totalCents = full reversal (same as in-lock)
        const [sale, refund, reversal] = await Promise.all([
          findSaleAsync(refundEvent.providerName, refundEvent.saleId),
          findRefundAsync(refundEvent.providerName, refundEvent.saleId),
          findRefundReversalAsync(refundEvent.providerName, refundEvent.saleId),
        ]);
        if (!sale || !refund) return false;
        if (refundEvent.totalCents !== undefined && refundEvent.totalCents !== Math.round(sale.amount_usd * 100)) return false;
        const saleCurrency = (sale.currency ?? GLOBAL.defaults.currency).toUpperCase();
        if (refundEvent.currency !== undefined && refundEvent.currency.toUpperCase() !== saleCurrency) return false;
        if (refundEvent.providerAdjustmentId) {
          try {
            if (await findByProviderAdjustmentIdAsync(refundEvent.providerName, refundEvent.providerAdjustmentId, "refund")) return true;
          } catch {
            return false; // fail closed: lookup errors make the provider retry
          }
        }
        return !reversal;
      },
      async () => {
        if (refundEvent.amountUnverifiable === true) {
          const sale = await findSaleAsync(refundEvent.providerName, refundEvent.saleId);
          await flagRefundForManualReview({
            reason: "amount_unverifiable",
            provider: refundEvent.providerName,
            sale_id: refundEvent.saleId,
            refund_id: refundEvent.refundId ?? null,
            refund_cents: null,
            sale_cents: sale ? Math.round(sale.amount_usd * 100) : null,
            creator_id: sale?.creator_id ?? null,
            occurred_at: refundEvent.occurredAt,
          });
          throw new Error(
            `Webhook validation failed: refund amount unverifiable for sale ${refundEvent.saleId} — flagged for manual review`,
          );
        }
        const original = await findSaleAsync(refundEvent.providerName, refundEvent.saleId);
        if (original && refundEvent.currency !== undefined) {
          const saleCurrency = (original.currency ?? GLOBAL.defaults.currency).toUpperCase();
          if (refundEvent.currency.toUpperCase() !== saleCurrency) {
            await flagRefundForManualReview({
              reason: "currency_mismatch",
              provider: refundEvent.providerName,
              sale_id: refundEvent.saleId,
              refund_id: refundEvent.refundId ?? null,
              refund_cents: refundEvent.totalCents ?? null,
              sale_cents: Math.round(original.amount_usd * 100),
              creator_id: original.creator_id ?? null,
              occurred_at: refundEvent.occurredAt,
            });
            throw new Error(
              `Webhook validation failed: refund currency ${refundEvent.currency} != sale ${saleCurrency} for sale ${refundEvent.saleId} — flagged for manual review`,
            );
          }
        }
        if (refundEvent.totalCents !== undefined) {
          const saleCents = original ? Math.round(original.amount_usd * 100) : null;
          if (saleCents !== null && refundEvent.totalCents !== saleCents) {
            await flagRefundForManualReview({
              reason: "amount_mismatch",
              provider: refundEvent.providerName,
              sale_id: refundEvent.saleId,
              refund_id: refundEvent.refundId ?? null,
              refund_cents: refundEvent.totalCents,
              sale_cents: saleCents,
              creator_id: original?.creator_id ?? null,
              occurred_at: refundEvent.occurredAt,
            });
            throw new Error(
              `Webhook validation failed: refund amount ${refundEvent.totalCents}c != sale ${saleCents}c for sale ${refundEvent.saleId} — full reversals only, flagged for manual review`,
            );
          }
        }
        // Duplicate check AFTER amount validation: a second refund event with a
        // mismatched amount for an already-refunded sale is a different refund and
        // must be flagged, not acknowledged as a duplicate of the first.
        const existingRefund = await findRefundAsync(refundEvent.providerName, refundEvent.saleId);
        if (existingRefund) {
          // Replay of the SAME adjustment (chargeback .created/.updated share one id) is a
          // no-op success — including after a won dispute recorded a reversal.
          if (refundEvent.providerAdjustmentId) {
            try {
              if (await findByProviderAdjustmentIdAsync(refundEvent.providerName, refundEvent.providerAdjustmentId, "refund")) {
                return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", dedupe: "provider_adjustment_id", event_type: "refund", sale_id: refundEvent.saleId } };
              }
            } catch (err) {
              // Fail closed: a broken lookup can't tell a replay from a new chargeback, so the
              // provider retries (500) instead of this delivery being flagged or dropped.
              console.error("[billing-webhook] adjustment-id dedupe lookup failed:", err);
              throw err;
            }
          }
          // A reversal can only exist once a refund does. After a won dispute the ledger can't hold a
          // second refund row (unique provider+sale_id+event_type), and without a stored refund_id a
          // replay of the original chargeback can't be told apart from a new one, so flag either way.
          const existingReversal = await findRefundReversalAsync(refundEvent.providerName, refundEvent.saleId);
          if (existingReversal) {
            await flagRefundForManualReview({
              reason: "refund_after_reversal",
              provider: refundEvent.providerName,
              sale_id: refundEvent.saleId,
              refund_id: refundEvent.refundId ?? null,
              refund_cents: refundEvent.totalCents ?? null,
              sale_cents: original ? Math.round(original.amount_usd * 100) : null,
              creator_id: original?.creator_id ?? null,
              occurred_at: refundEvent.occurredAt,
            });
            return { status: 200, payload: { ok: true, recorded: false, reason: "manual_review" } };
          }
          return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", event_type: "refund", sale_id: refundEvent.saleId } };
        }
        // appendRefund refuses (throws → 500, provider retries) when the sale is not recorded yet.
        try {
          await appendRefund({
            provider: refundEvent.providerName,
            sale_id: refundEvent.saleId,
            ts: refundEvent.occurredAt,
            provider_adjustment_id: refundEvent.providerAdjustmentId
          });
        } catch (err) {
          // A 23505 on orders_provider_adjustment_id_uniq means the same adjustment was
          // persisted by a concurrent delivery — a replay ONLY if the conflicting row
          // matches this event; otherwise flag + 503 (see resolveAdjustmentIdCollision).
          if (refundEvent.providerAdjustmentId && isAdjustmentIdUniqueViolation(err)) {
            return await resolveAdjustmentIdCollision(
              refundEvent.providerName,
              refundEvent.providerAdjustmentId,
              "refund",
              { saleId: refundEvent.saleId, totalCents: refundEvent.totalCents, currency: refundEvent.currency },
              { refundId: refundEvent.refundId ?? null, refundCents: refundEvent.totalCents ?? null, occurredAt: refundEvent.occurredAt },
            );
          }
          throw err;
        }
        return { status: 200, payload: { ok: true, recorded: true, event_type: "refund", sale_id: refundEvent.saleId } };
      },
    );
    return;
  }

  // 4b. Refund reversed (won chargeback / dispute reversal)
  if (event.eventType === "refund_reversed") {
    const revEvent = event as RefundReversedEvent;
    await underLockOrConfirmed(
      `lock:refund:${revEvent.providerName}:${revEvent.saleId}`,
      async () => (await findRefundReversalAsync(revEvent.providerName, revEvent.saleId)) !== null,
      async () => {
        const sale = await findSaleAsync(revEvent.providerName, revEvent.saleId);
        const refund = await findRefundAsync(revEvent.providerName, revEvent.saleId);

        if (!sale || !refund) {
          // No clock heuristics: a reversal we can't match to a recorded refund (out of order, or the
          // refund itself went to manual review) is flagged and acked; ops settles it by hand.
          // Repeat deliveries add rows that listManualReviewRefunds collapses per (provider, sale_id).
          await flagRefundForManualReview({
            reason: "reversal_without_refund",
            provider: revEvent.providerName,
            sale_id: revEvent.saleId,
            refund_id: revEvent.refundId ?? null,
            refund_cents: revEvent.totalCents ?? null,
            sale_cents: sale ? Math.round(sale.amount_usd * 100) : null,
            creator_id: sale?.creator_id ?? null,
            occurred_at: revEvent.occurredAt,
          });
          return { status: 200, payload: { ok: true, recorded: false, reason: "manual_review" } };
        }

        if (revEvent.currency !== undefined) {
          const saleCurrency = (sale.currency ?? GLOBAL.defaults.currency).toUpperCase();
          if (revEvent.currency.toUpperCase() !== saleCurrency) {
            await flagRefundForManualReview({
              reason: "currency_mismatch",
              provider: revEvent.providerName,
              sale_id: revEvent.saleId,
              refund_id: revEvent.refundId ?? null,
              refund_cents: revEvent.totalCents ?? null,
              sale_cents: Math.round(sale.amount_usd * 100),
              creator_id: sale.creator_id ?? null,
              occurred_at: revEvent.occurredAt,
            });
            return { status: 200, payload: { ok: true, recorded: false, reason: "manual_review" } };
          }
        }

        if (revEvent.totalCents === undefined) {
          await flagRefundForManualReview({
            reason: "reversal_amount_unverifiable",
            provider: revEvent.providerName,
            sale_id: revEvent.saleId,
            refund_id: revEvent.refundId ?? null,
            refund_cents: null,
            sale_cents: Math.round(sale.amount_usd * 100),
            creator_id: sale.creator_id ?? null,
            occurred_at: revEvent.occurredAt,
          });
          return { status: 200, payload: { ok: true, recorded: false, reason: "manual_review" } };
        }

        const saleCents = Math.round(sale.amount_usd * 100);
        if (revEvent.totalCents !== saleCents) {
          await flagRefundForManualReview({
            reason: "reversal_amount_mismatch",
            provider: revEvent.providerName,
            sale_id: revEvent.saleId,
            refund_id: revEvent.refundId ?? null,
            refund_cents: revEvent.totalCents,
            sale_cents: saleCents,
            creator_id: sale.creator_id ?? null,
            occurred_at: revEvent.occurredAt,
          });
          return { status: 200, payload: { ok: true, recorded: false, reason: "manual_review" } };
        }

        const existingReversal = await findRefundReversalAsync(revEvent.providerName, revEvent.saleId);
        if (existingReversal) {
          return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", event_type: "refund_reversal", sale_id: revEvent.saleId } };
        }
        try {
          await appendRefundReversal({
            provider: revEvent.providerName,
            sale_id: revEvent.saleId,
            ts: revEvent.occurredAt,
            provider_adjustment_id: revEvent.providerAdjustmentId
          });
        } catch (err) {
          // Same rule as refunds: a violation of orders_provider_adjustment_id_uniq is a
          // replay only when the conflicting row matches this event; otherwise flag + 503.
          if (revEvent.providerAdjustmentId && isAdjustmentIdUniqueViolation(err)) {
            return await resolveAdjustmentIdCollision(
              revEvent.providerName,
              revEvent.providerAdjustmentId,
              "refund_reversal",
              { saleId: revEvent.saleId, totalCents: revEvent.totalCents, currency: revEvent.currency },
              { refundId: revEvent.refundId ?? null, refundCents: revEvent.totalCents ?? null, occurredAt: revEvent.occurredAt },
            );
          }
          throw err;
        }
        return { status: 200, payload: { ok: true, recorded: true, event_type: "refund_reversal", sale_id: revEvent.saleId } };
      },
    );
    return;
  }

  // 5. Sale completed
  if (event.eventType === "sale_completed") {
    const saleEvent = event as SaleCompletedEvent;

    // 5a. Distributed idempotency lock: concurrent/duplicate deliveries for the same sale
    // take the lock. Already-recorded sale → return normally (no double payout); lock held
    // by an in-flight delivery → WebhookInFlightError → 503 so the provider retries.
    // withIdempotencyLock also frees the slot when nothing was written (payload.recorded !== true).
    await underLockOrConfirmed(
      `lock:sale:${saleEvent.providerName}:${saleEvent.saleId}`,
      async () => (await findSaleAsync(saleEvent.providerName, saleEvent.saleId)) !== null,
      async () => {
        // Duplicate guard: if sale already recorded, exit early without duplicating splits
        const existing = await findSaleAsync(saleEvent.providerName, saleEvent.saleId);
        if (existing) {
          return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", sale_id: saleEvent.saleId } };
        }

        // Resolve product config to determine creator and split
        const cfg = loadProductIndex().get(saleEvent.productId);
        if (!cfg) throw new Error(`Unknown product_id: ${saleEvent.productId}`);

        // Never book a foreign-currency total as the product's currency (audit F4).
        if (saleEvent.currency.toUpperCase() !== cfg.currency.toUpperCase()) {
          const err = new Error(
            `Webhook validation failed: sale ${saleEvent.saleId} currency ${saleEvent.currency} != product currency ${cfg.currency}`,
          ) as Error & { httpStatus?: number };
          err.httpStatus = 422;
          throw err;
        }

        // Compute split
        const creatorPct = effectiveCreatorSplitPct(cfg.creator_id, cfg.product_id, saleEvent.occurredAt);
        if (creatorPct === null) throw new Error(`Could not resolve split percentage for creator ${cfg.creator_id}`);

        const amountUsd = saleEvent.totalCents / 100; // Ledger still stores USD float — convert from canonical cents
        const split = computeSplit(amountUsd, creatorPct);

        // Append to ledger
        await appendSale({
          sale_id: saleEvent.saleId,
          provider: saleEvent.providerName,
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
