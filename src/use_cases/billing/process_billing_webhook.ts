/**
 * process_billing_webhook.ts — Application use case: handle an inbound billing webhook
 *
 * Receives provider-agnostic BillingEvent from adapter layer.
 * Delegates to the ledger for persistence.
 * Knows nothing about Polar, Paddle, or any provider.
 * ADR: ADR-0049, ADR-0050
 */
import { PaymentProviderPort, BillingEvent, SaleCompletedEvent, RefundIssuedEvent, RefundReversedEvent } from "../../domain/payments/payments.port.ts";
import { WebhookValidationError } from "../../domain/webhook/webhook_errors.ts";
import { persistSale, appendRefund, appendRefundReversal, findSaleAsync, findRefundAsync, findRefundReversalAsync, findByProviderAdjustmentIdAsync, flagRefundForManualReview, recordWebhookConflict, isAdjustmentIdUniqueViolation, mirrorToLocalLedger, OrderSchemaError } from "../../../payments/src/ledger.ts";
import { computeSplit, usdToCents } from "../../../payments/src/split.ts";
import { effectiveCreatorSplitPctAsync } from "../../../payments/src/terms.ts";
import { resolveProductByAlias, withIdempotencyLock, WebhookInFlightError } from "../../../payments/src/webhook_core.ts";
import { deliverSaleForWebhook, saleDeliveryConfirmed } from "../../../payments/src/delivery.ts";
import { DeliveryPendingError } from "../../../payments/src/delivery_errors.ts";
import { budgetLeftMs, requestSignal, settleByDeadline } from "../../../payments/src/webhook_budget.ts";
import { GLOBAL } from "../../../payments/src/settings_registry.ts";

type DeliveryInput = Parameters<typeof deliverSaleForWebhook>[0];

/** Wraps a pre-persist read so a budget-expired abort becomes a retryable 503 (DeliveryPendingError), never an untyped 500. */
async function withBudgetRead<T>(deadlineAt: number | undefined, saleId: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (deadlineAt !== undefined && budgetLeftMs(deadlineAt) <= 0) {
      throw new DeliveryPendingError(saleId, err);
    }
    throw err;
  }
}

/**
 * The receipt send, raced against the request deadline (payments.webhook_total_budget_ms). Past the deadline the answer is a 503
 * (DeliveryPendingError) and the sale is already booked. The send is not aborted, so it may still finish; the provider's retry
 * then takes the duplicate path and resends the stored message under the same idempotency key.
 */
export function deliverWithinBudget(input: DeliveryInput): Promise<void> {
  if (input.deadlineAt === undefined) return deliverSaleForWebhook(input);
  const work = deliverSaleForWebhook(input);
  // The lock holder keeps the lock until the send still running (if any) settles. A pending error from inside the work carries
  // its send's settlement (delivery.ts), so this waits for that send, not for the work alone: the work can end while its send
  // is still in flight. Work that ends with no send running settles with the work. The rejection itself is surfaced through the race.
  const settled = work.then(
    () => undefined,
    (err: unknown) => (err instanceof DeliveryPendingError ? err.backgroundWork : undefined),
  );
  return settleByDeadline(work, input.deadlineAt, () =>
    new DeliveryPendingError(input.saleId, new Error("webhook budget exhausted (payments.webhook_total_budget_ms)"), settled),
  );
}

type LockedResult = { status: number; payload: Record<string, unknown> };
type LockedFn = (fenceToken?: number) => Promise<LockedResult>;

function requireLockPrefix(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`billing-webhook: missing payments.${name} in settings registry`);
  }
  return value;
}

/**
 * A mismatching adjustment-id collision stored in the reconciliation inbox (public.webhook_conflicts).
 * The route answers 200 (Paddle documents 200 as success; any other status is retried). The event lives on in the
 * inbox until an operator resolves it. Never produced without a durable row.
 */
export interface ConflictPendingOutcome {
  status: 200;
  payload: { ok: true; recorded: false; reason: "conflict_pending"; conflict_id: number; event_type: "refund" | "refund_reversal"; sale_id: string };
}

function asConflictPending(result: LockedResult | undefined): ConflictPendingOutcome | undefined {
  return result?.payload?.reason === "conflict_pending" ? (result as ConflictPendingOutcome) : undefined;
}

/**
 * 23505 on orders_provider_adjustment_id_uniq: a concurrent delivery won the
 * index — but only a conflicting row that MATCHES this event (same sale,
 * same amount, same currency) is a genuine replay worth acknowledging 200.
 * Anything else is a real collision: the incoming event is stored in the
 * reconciliation inbox together with the manual-review flag (one atomic RPC) and
 * answered 200 conflict_pending. A write failure must never soften into a 200
 * without a stored row: it surfaces as a retryable 503 so the provider redelivers.
 */
/**
 * Terminal 422 for a sale the mode gate refuses. The error name is the quarantine reason (the route records err.name in
 * WEBHOOK_TERMINAL_REJECT), so an operator can tell a mode mismatch from an unknown product. The message is not
 * persisted: it can carry buyer data.
 */
function saleRefused(reason: "SALE_MODE_MISMATCH" | "SALE_MODE_UNKNOWN", message: string): WebhookValidationError {
  const err = new WebhookValidationError(`Webhook validation failed: ${message}`, 422);
  err.name = reason;
  return err;
}

/** Retryable 503 with a distinct error name, so the route's WEBHOOK_503_RETRYING audit (err.name) tells the collision failure modes apart. */
function collisionRetryable(name: string, message: string): Error {
  const err = new Error(`Webhook retryable: ${message}`);
  err.name = name;
  return Object.assign(err, { httpStatus: 503 });
}

function adjustmentRowMatchesEvent(
  row: { sale_id: string; amount_usd: number; currency?: string | null },
  event: { saleId: string; totalCents?: number; currency?: string },
): boolean {
  let rowCents: number;
  try {
    rowCents = usdToCents(row.amount_usd);
  } catch (err) {
    console.error("[billing-webhook] adjustment row amount unparseable:", err);
    return false;
  }
  return (
    row.sale_id === event.saleId &&
    (event.totalCents === undefined || rowCents === event.totalCents) &&
    (event.currency === undefined || (row.currency ?? "").toUpperCase() === event.currency.toUpperCase())
  );
}

async function persistAdjustmentCollision(
  provider: string,
  adjustmentId: string,
  eventType: "refund" | "refund_reversal",
  event: { saleId: string; totalCents?: number; currency?: string },
  flag: { refundId: string | null; refundCents: number | null; occurredAt: string },
  conflicting: { sale_id: string; cents: number; currency: string | null; creator_id: string | null },
): Promise<LockedResult> {
  let conflictId: number;
  try {
    conflictId = await recordWebhookConflict(
      {
        provider,
        event_type: eventType,
        sale_id: event.saleId,
        adjustment_id: adjustmentId,
        total_cents: event.totalCents ?? null,
        currency: event.currency ?? null,
        occurred_at: flag.occurredAt,
        refund_id: flag.refundId,
      },
      {
        reason: "adjustment_id_collision",
        provider,
        sale_id: event.saleId,
        refund_id: flag.refundId,
        refund_cents: flag.refundCents,
        sale_cents: conflicting.cents,
        creator_id: conflicting.creator_id,
        occurred_at: flag.occurredAt,
        adjustment_id: adjustmentId,
        event_type: eventType,
        incoming_currency: event.currency ?? null,
        conflicting_sale_id: conflicting.sale_id,
        conflicting_cents: conflicting.cents,
        conflicting_currency: conflicting.currency,
      },
    );
  } catch (recordErr) {
    console.error("[billing-webhook] adjustment_id_collision conflict write failed:", recordErr);
    throw collisionRetryable("AdjustmentIdCollisionRecordError", `adjustment-id collision conflict write failed for ${eventType} ${adjustmentId}`);
  }
  return { status: 200, payload: { ok: true, recorded: false, reason: "conflict_pending", conflict_id: conflictId, event_type: eventType, sale_id: event.saleId } };
}

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
): Promise<LockedResult> {
  let row: Awaited<ReturnType<typeof findByProviderAdjustmentIdAsync>> | null = null;
  try {
    row = await findByProviderAdjustmentIdAsync(provider, adjustmentId, eventType);
  } catch (lookupErr) {
    console.error("[billing-webhook] collision-adjustment lookup failed:", lookupErr);
    throw collisionRetryable("AdjustmentIdCollisionLookupError", `adjustment-id collision lookup failed for ${eventType} ${adjustmentId}`);
  }
  if (!row) {
    throw collisionRetryable("AdjustmentIdCollisionNoRowError", `adjustment-id collision with no recoverable row for ${eventType} ${adjustmentId}`);
  }
  let rowCents: number;
  try {
    rowCents = usdToCents(row.amount_usd);
  } catch (convertErr) {
    console.error("[billing-webhook] collision-adjustment amount unparseable:", convertErr);
    throw collisionRetryable("AdjustmentIdCollisionAmountError", `adjustment-id collision row amount unparseable for ${eventType} ${adjustmentId}`);
  }
  const matches =
    row.sale_id === event.saleId &&
    (event.totalCents === undefined || rowCents === event.totalCents) &&
    (event.currency === undefined || (row.currency ?? "").toUpperCase() === event.currency.toUpperCase());
  if (matches) {
    return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", dedupe: "provider_adjustment_id", event_type: eventType, sale_id: event.saleId } };
  }
  return persistAdjustmentCollision(provider, adjustmentId, eventType, event, flag, {
    sale_id: row.sale_id,
    cents: rowCents,
    currency: row.currency ?? null,
    creator_id: row.creator_id ?? null,
  });
}
/**
 * Run fn under the idempotency lock. A held lock is NOT success — the holder may
 * still fail. Acknowledge only when the record is confirmed durable; otherwise
 * rethrow WebhookInFlightError so the route answers 503 and the provider retries.
 */
async function underLockOrConfirmed(lockKey: string, isPersisted: () => Promise<boolean>, fn: LockedFn): Promise<LockedResult | undefined> {
  try {
    return await withIdempotencyLock(lockKey, fn);
  } catch (err) {
    if (err instanceof WebhookInFlightError && (await isPersisted())) return undefined;
    throw err;
  }
}

export interface ProcessWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Absolute epoch-ms answer deadline (payments.webhook_total_budget_ms). Delivery and the buyer lookup take only what is left. */
  deadlineAt?: number;
}

export async function processBillingWebhookUseCase(
  req: ProcessWebhookRequest,
  adapters: PaymentProviderPort[]
): Promise<ConflictPendingOutcome | void> {
  // 1. Signature-based routing — identity established from cryptographic evidence, never URL
  let matchedAdapter: PaymentProviderPort | undefined;
  for (const adapter of adapters) {
    if (adapter.canHandleWebhook(req.headers, req.body)) {
      matchedAdapter = adapter;
      break;
    }
  }

  if (!matchedAdapter) {
    // No adapter claims the signature headers → nothing was verified. Marked senderVerified=false so the
    // route does NOT quarantine or audit it: an unverified request must write no row, whatever its shape
    // (unauthenticated traffic must not force audit_log writes, PR #78). A provider-shaped delivery with no
    // routable adapter is answered 400 and logged. Replay needs a verifier for that provider.
    const err = new WebhookValidationError("No payment provider configured to handle this webhook signature.");
    err.senderVerified = false;
    throw err;
  }

  // 2. Zod-enforced parse — strict SSOT shape validation
  const validation = await matchedAdapter.parseAndValidateWebhook(req.headers, req.body, { deadlineAt: req.deadlineAt });

  if (!validation.isValid) {
    // The adapter's httpStatus hint (401 bad signature, 500 missing secret,
    // 503 recoverable state) travels with the typed error; undefined → 400.
    throw new WebhookValidationError(
      `Webhook validation failed for ${matchedAdapter.providerName}: ${validation.error}`,
      validation.httpStatus,
    );
  }

  // A delivery may carry several events (FastSpring). Every event runs, even after a sibling fails:
  // a terminal (4xx) answer stops the provider's redelivery, so an event skipped behind it would be
  // lost for good. After the loop, the first retryable failure is rethrown (the route answers 5xx/503
  // and the provider redelivers; events already recorded dedupe by sale id under the lock). With no
  // retryable failure, the first terminal failure is rethrown (the route quarantines the delivery and
  // answers 4xx). With no failure, the first conflict_pending outcome is reported.
  const events = [validation.event, ...(validation.followingEvents ?? [])];
  let conflict: ConflictPendingOutcome | undefined;
  let retryable: unknown;
  let terminal: unknown;
  for (const [index, event] of events.entries()) {
    try {
      const outcome = await processBillingEvent(event, req.deadlineAt); // always runs: never inside ??= (short-circuit)
      conflict ??= outcome ?? undefined;
    } catch (err) {
      if (events.length > 1) {
        // Error name only: messages can carry buyer data.
        const saleId = "saleId" in event ? event.saleId : undefined;
        console.error(`[billing-webhook] event ${index + 1}/${events.length} (${event.eventType} ${saleId ?? "-"}) failed: ${err instanceof Error ? err.name : "unknown"}`);
      }
      if (isTerminalFailure(err)) terminal ??= err;
      else retryable ??= err;
    }
  }
  if (retryable !== undefined) throw retryable;
  if (terminal !== undefined) throw terminal;
  return conflict;
}

/**
 * True when the route answers this error with a final 4xx (the provider stops redelivering): a
 * ledger schema violation, or a validation error with no status or a status below 500. Everything
 * else (5xx hints, the in-flight lock, unexpected throws) is retryable. Mirrors handler.ts.
 */
function isTerminalFailure(err: unknown): boolean {
  if (err instanceof OrderSchemaError) return true;
  if (!(err instanceof WebhookValidationError)) return false;
  return err.httpStatus === undefined || err.httpStatus < 500;
}

async function processBillingEvent(event: BillingEvent, deadlineAt?: number): Promise<ConflictPendingOutcome | void> {
  // 3. Ignored events — return silently (controller replies 200)
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
    const refundLockPrefix = requireLockPrefix(GLOBAL.payments.webhook_lock_refund_prefix, "webhook_lock_refund_prefix");
    const refundResult = await underLockOrConfirmed(
      `${refundLockPrefix}${refundEvent.providerName}:${refundEvent.saleId}`,
      // Confirm a contended refund only when THIS delivery would itself pass the in-lock checks
      // (verifiable amount equal to the sale, same currency), in the same order as in-lock: a
      // partial/over/foreign-currency refund retries and gets flagged inside. Then either the refund
      // row carrying this adjustment id proves it was handled (also after a won dispute), or, with no
      // adjustment id match, the sale must still be refunded and not yet reversed.
      async () => {
        if (refundEvent.amountUnverifiable === true || refundEvent.settled === false) return false; // absent totalCents = full reversal (same as in-lock)
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
          // The lookup resolves null only for "no such row". A lookup error, or any other fault, is NOT "not persisted":
          // log and rethrow, so the delivery answers 500 and the provider retries (a bare catch here would mask it as 503).
          try {
            const adjRow = await findByProviderAdjustmentIdAsync(refundEvent.providerName, refundEvent.providerAdjustmentId, "refund");
            if (adjRow) {
              return adjustmentRowMatchesEvent(adjRow, {
                saleId: refundEvent.saleId,
                totalCents: refundEvent.totalCents,
                currency: refundEvent.currency,
              });
            }
          } catch (err) {
            console.error("[billing-webhook] refund confirm: adjustment-id lookup failed:", err instanceof Error ? err.message : String(err));
            throw err;
          }
        }
        return !reversal;
      },
      async (fenceToken) => {
        // An unsettled refund (Polar pending/failed/canceled) is never applied, whatever its amount: it goes to manual review.
        if (refundEvent.amountUnverifiable === true || refundEvent.settled === false) {
          const sale = await findSaleAsync(refundEvent.providerName, refundEvent.saleId);
          await flagRefundForManualReview({
            reason: refundEvent.settled === false ? "refund_not_settled" : "amount_unverifiable",
            provider: refundEvent.providerName,
            sale_id: refundEvent.saleId,
            refund_id: refundEvent.refundId ?? null,
            // An unsettled refund still carries the amount Polar requested: keep it so the queue shows it.
            refund_cents: refundEvent.settled === false ? (refundEvent.totalCents ?? null) : null,
            sale_cents: sale ? Math.round(sale.amount_usd * 100) : null,
            creator_id: sale?.creator_id ?? null,
            occurred_at: refundEvent.occurredAt,
          });
          throw new WebhookValidationError(
            refundEvent.settled === false
              ? `Webhook validation failed: refund not settled for sale ${refundEvent.saleId} — flagged for manual review`
              : `Webhook validation failed: refund amount unverifiable for sale ${refundEvent.saleId} — flagged for manual review`,
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
            throw new WebhookValidationError(
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
            throw new WebhookValidationError(
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
            let adjRow: Awaited<ReturnType<typeof findByProviderAdjustmentIdAsync>> | null = null;
            try {
              adjRow = await findByProviderAdjustmentIdAsync(refundEvent.providerName, refundEvent.providerAdjustmentId, "refund");
            } catch (err) {
              // Fail closed: a broken lookup can't tell a replay from a new chargeback, so the
              // provider retries (500) instead of this delivery being flagged or dropped.
              console.error("[billing-webhook] adjustment-id dedupe lookup failed:", err instanceof Error ? err.message : String(err));
              throw err;
            }
            if (adjRow) {
              return await resolveAdjustmentIdCollision(
                refundEvent.providerName,
                refundEvent.providerAdjustmentId,
                "refund",
                { saleId: refundEvent.saleId, totalCents: refundEvent.totalCents, currency: refundEvent.currency },
                { refundId: refundEvent.refundId ?? null, refundCents: refundEvent.totalCents ?? null, occurredAt: refundEvent.occurredAt },
              );
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
          }, undefined, fenceToken);
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
    return asConflictPending(refundResult);
  }

  // 4b. Refund reversed (won chargeback / dispute reversal)
  if (event.eventType === "refund_reversed") {
    const revEvent = event as RefundReversedEvent;
    const refundLockPrefix = requireLockPrefix(GLOBAL.payments.webhook_lock_refund_prefix, "webhook_lock_refund_prefix");
    const reversalResult = await underLockOrConfirmed(
      `${refundLockPrefix}${revEvent.providerName}:${revEvent.saleId}`,
      async () => {
        const [sale, reversal] = await Promise.all([
          findSaleAsync(revEvent.providerName, revEvent.saleId),
          findRefundReversalAsync(revEvent.providerName, revEvent.saleId),
        ]);
        if (!sale || !reversal) return false;
        const saleCurrency = (sale.currency ?? GLOBAL.defaults.currency).toUpperCase();
        if (revEvent.currency !== undefined && revEvent.currency.toUpperCase() !== saleCurrency) return false;
        if (revEvent.totalCents === undefined || revEvent.totalCents !== Math.round(sale.amount_usd * 100)) return false;
        if (!adjustmentRowMatchesEvent(reversal, { saleId: revEvent.saleId, totalCents: revEvent.totalCents, currency: revEvent.currency })) {
          return false;
        }
        if (revEvent.providerAdjustmentId) {
          try {
            const adjRow = await findByProviderAdjustmentIdAsync(revEvent.providerName, revEvent.providerAdjustmentId, "refund_reversal");
            if (adjRow) {
              return adjustmentRowMatchesEvent(adjRow, {
                saleId: revEvent.saleId,
                totalCents: revEvent.totalCents,
                currency: revEvent.currency,
              });
            }
          } catch (err) {
            console.error("[billing-webhook] reversal confirm: adjustment-id lookup failed:", err instanceof Error ? err.message : String(err));
            throw err;
          }
          if (reversal.provider_adjustment_id && reversal.provider_adjustment_id !== revEvent.providerAdjustmentId) {
            return false;
          }
        }
        return true;
      },
      async (fenceToken) => {
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
          if (revEvent.providerAdjustmentId) {
            let adjRow: Awaited<ReturnType<typeof findByProviderAdjustmentIdAsync>> | null = null;
            try {
              adjRow = await findByProviderAdjustmentIdAsync(revEvent.providerName, revEvent.providerAdjustmentId, "refund_reversal");
            } catch (err) {
              console.error("[billing-webhook] reversal adjustment-id dedupe lookup failed:", err instanceof Error ? err.message : String(err));
              throw err;
            }
            if (adjRow) {
              return await resolveAdjustmentIdCollision(
                revEvent.providerName,
                revEvent.providerAdjustmentId,
                "refund_reversal",
                { saleId: revEvent.saleId, totalCents: revEvent.totalCents, currency: revEvent.currency },
                { refundId: revEvent.refundId ?? null, refundCents: revEvent.totalCents ?? null, occurredAt: revEvent.occurredAt },
              );
            }
            if (existingReversal.provider_adjustment_id && existingReversal.provider_adjustment_id !== revEvent.providerAdjustmentId) {
              return await persistAdjustmentCollision(
                revEvent.providerName,
                revEvent.providerAdjustmentId,
                "refund_reversal",
                { saleId: revEvent.saleId, totalCents: revEvent.totalCents, currency: revEvent.currency },
                { refundId: revEvent.refundId ?? null, refundCents: revEvent.totalCents ?? null, occurredAt: revEvent.occurredAt },
                {
                  sale_id: existingReversal.sale_id,
                  cents: usdToCents(existingReversal.amount_usd),
                  currency: existingReversal.currency ?? null,
                  creator_id: existingReversal.creator_id ?? null,
                },
              );
            }
          }
          const existingCents = usdToCents(existingReversal.amount_usd);
          const existingCurrency = (existingReversal.currency ?? GLOBAL.defaults.currency).toUpperCase();
          if (revEvent.currency !== undefined && revEvent.currency.toUpperCase() !== existingCurrency) {
            await flagRefundForManualReview({
              reason: "currency_mismatch",
              provider: revEvent.providerName,
              sale_id: revEvent.saleId,
              refund_id: revEvent.refundId ?? null,
              refund_cents: revEvent.totalCents ?? null,
              sale_cents: existingCents,
              creator_id: existingReversal.creator_id ?? null,
              occurred_at: revEvent.occurredAt,
            });
            return { status: 200, payload: { ok: true, recorded: false, reason: "manual_review" } };
          }
          if (revEvent.totalCents !== existingCents) {
            await flagRefundForManualReview({
              reason: "reversal_amount_mismatch",
              provider: revEvent.providerName,
              sale_id: revEvent.saleId,
              refund_id: revEvent.refundId ?? null,
              refund_cents: revEvent.totalCents,
              sale_cents: existingCents,
              creator_id: existingReversal.creator_id ?? null,
              occurred_at: revEvent.occurredAt,
            });
            return { status: 200, payload: { ok: true, recorded: false, reason: "manual_review" } };
          }
          return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", event_type: "refund_reversal", sale_id: revEvent.saleId } };
        }
        try {
          await appendRefundReversal({
            provider: revEvent.providerName,
            sale_id: revEvent.saleId,
            ts: revEvent.occurredAt,
            provider_adjustment_id: revEvent.providerAdjustmentId
          }, undefined, fenceToken);
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
    return asConflictPending(reversalResult);
  }

  // 5. Sale completed
  if (event.eventType === "sale_completed") {
    const saleEvent = event as SaleCompletedEvent;
    const saleLockPrefix = requireLockPrefix(GLOBAL.payments.webhook_lock_sale_prefix, "webhook_lock_sale_prefix");
    // Every Supabase read on the sale path takes this signal, so a hung read is cut at the request budget. The sale write does not.
    const readSignal = requestSignal(deadlineAt);

    // 5a. Distributed idempotency lock: concurrent/duplicate deliveries for the same sale
    // take the lock. Already-recorded sale → the lock holder re-attempts delivery under the lock
    // (no double payout); lock held by another delivery → WebhookInFlightError → 503 so the provider retries.
    // A recorded sale is never acknowledged from outside the lock: the holder may still be delivering it,
    // or may have failed. Only a retry that takes the lock can confirm delivery.
    // withIdempotencyLock also frees the slot when nothing was written (payload.recorded !== true).
    // A contended lock is acknowledged only when the sale is recorded AND its receipt is confirmed sent. A recorded
    // sale alone is not enough: the holder may still fail the send, and a 200 would stop the provider's retries.
    await underLockOrConfirmed(
      `${saleLockPrefix}${saleEvent.providerName}:${saleEvent.saleId}`,
      async () =>
        withBudgetRead(deadlineAt, saleEvent.saleId, async () =>
          Boolean(await findSaleAsync(saleEvent.providerName, saleEvent.saleId, undefined, readSignal)) &&
          (await saleDeliveryConfirmed(saleEvent.providerName, saleEvent.saleId, deadlineAt)),
        ),
      async (fenceToken) => {
        // Fail closed for a non-Paddle sale without a buyer email: no download link can be sent, and a retry cannot
        // change that. Delivery would throw on every retry (a 500 loop), so the sale is refused with a final 422.
        if (saleEvent.providerName !== "paddle" && !saleEvent.buyerEmail) {
          console.error(`[billing-webhook] sale ${saleEvent.saleId} from ${saleEvent.providerName} has no buyer email; refused`);
          throw new WebhookValidationError(
            `Webhook validation failed: sale ${saleEvent.saleId} from ${saleEvent.providerName} has no buyer email; refused, no download link can be sent`,
            422,
          );
        }
        // Duplicate guard: if sale already recorded, do not duplicate splits. A prior attempt may have
        // failed after the ledger write, so re-attempt delivery; it is idempotent per sale, and a
        // failure rethrows (500) so the provider retries.
        const existing = await withBudgetRead(deadlineAt, saleEvent.saleId, () =>
          findSaleAsync(saleEvent.providerName, saleEvent.saleId, undefined, readSignal),
        );
        if (existing) {
          // Deliver first: a local-file fault must never block the buyer's email. Delivery is idempotent per sale.
          await deliverWithinBudget({
            provider: saleEvent.providerName,
            saleId: saleEvent.saleId,
            productAlias: existing.product_id,
            buyerEmail: saleEvent.buyerEmail,
            ...(fenceToken !== undefined ? { fence: fenceToken } : {}),
            deadlineAt,
          });
          // Then heal a lost local append: the sale may be durable in Supabase only, and reports read the local file.
          // A failure here rethrows (500); the provider retries, delivery returns duplicate (no second email), and the mirror is retried.
          await mirrorToLocalLedger(existing);
          return { status: 200, payload: { ok: true, recorded: false, reason: "duplicate", sale_id: saleEvent.saleId } };
        }

        // Resolve product from the DATABASE (Sprint 15: commercial state is
        // DB-only — the provider's product alias must map to a products row).
        const cfg = await withBudgetRead(deadlineAt, saleEvent.saleId, () =>
          resolveProductByAlias(saleEvent.productId, saleEvent.providerName, readSignal),
        );
        // Terminal: the alias resolves to no product (no row, or an alias outside the allowed charset). A retry cannot create one; the quarantined event is for an operator.
        if (!cfg) throw new WebhookValidationError(`Unknown product_id for provider ${saleEvent.providerName}`, 422);

        // F-09 mode gate: a sale is booked only when the provider's mode equals the product's checkout_mode. Live money
        // never lands on a sandbox or gated product, and a test event never books a live product. Refused before any
        // write, so no ledger row exists and no link is minted (delivery runs only after persistSale).
        if (saleEvent.providerMode === undefined) {
          throw saleRefused("SALE_MODE_UNKNOWN", `sale ${saleEvent.saleId} from ${saleEvent.providerName} carries no provider mode; refused`);
        }
        if (cfg.checkoutMode !== saleEvent.providerMode) {
          throw saleRefused(
            "SALE_MODE_MISMATCH",
            `sale ${saleEvent.saleId} from ${saleEvent.providerName} mode ${saleEvent.providerMode} != product checkout_mode ${cfg.checkoutMode ?? "null"}; refused`,
          );
        }

        // Never book a foreign-currency total as the product's currency (audit F4).
        if (saleEvent.currency.toUpperCase() !== cfg.currency.toUpperCase()) {
          throw new WebhookValidationError(
            `Webhook validation failed: sale ${saleEvent.saleId} currency ${saleEvent.currency} != product currency ${cfg.currency}`,
            422,
          );
        }

        // Compute split (DB-backed creator_terms — latest effective_from <= sale time)
        const creatorPct = await withBudgetRead(deadlineAt, saleEvent.saleId, () =>
          effectiveCreatorSplitPctAsync(cfg.creatorHandle, cfg.productId, saleEvent.occurredAt, readSignal),
        );
        if (creatorPct === null) throw new Error(`Could not resolve split percentage for creator ${cfg.creatorHandle}`);

        const amountUsd = saleEvent.totalCents / 100; // Ledger still stores USD float — convert from canonical cents
        const split = computeSplit(amountUsd, creatorPct);

        // Durable Supabase write first (Supabase-first rule). The local mirror follows delivery, below.
        const saleRecord = await persistSale({
          sale_id: saleEvent.saleId,
          provider: saleEvent.providerName,
          product_id: cfg.productId,
          amount_usd: amountUsd,
          ts: saleEvent.occurredAt,
          email_hash: saleEvent.buyerEmailHash,
          creator_id: cfg.creatorHandle,
          creator_split_pct: creatorPct,
          creator_split_usd: split.creator_split_usd,
          our_split_usd: split.our_split_usd,
          currency: cfg.currency,
          ...(saleEvent.attributionId ? { attribution_id: saleEvent.attributionId } : {})
        }, fenceToken);
        // Receipt and download link, after the durable write. A delivery failure rethrows: the handler answers the error's own
        // status (503 for DeliveryPendingError, 422 or 503 for DeliveryBlockedError, 500 otherwise). The provider retries the
        // 503 and 500 answers, which re-attempt delivery on the duplicate path above.
        await deliverWithinBudget({
          provider: saleEvent.providerName,
          saleId: saleEvent.saleId,
          productAlias: cfg.productId,
          buyerEmail: saleEvent.buyerEmail,
          ...(fenceToken !== undefined ? { fence: fenceToken } : {}),
          deadlineAt,
        });
        // Then the local mirror, the same order as the duplicate path above. A failure here rethrows (500); the provider retries,
        // delivery returns duplicate (no second email), and the mirror is retried.
        await mirrorToLocalLedger(saleRecord);
        return { status: 200, payload: { ok: true, recorded: true, sale_id: saleEvent.saleId } };
      },
    );
  }
}
