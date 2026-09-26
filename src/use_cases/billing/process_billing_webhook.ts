import { PaymentProviderPort, WebhookEvent } from "../../domain/payments/payments.port.ts";
import { appendSale, appendRefund } from "../../../payments/src/ledger.ts";
import { computeSplit } from "../../../payments/src/split.ts";
import { effectiveCreatorSplitPct } from "../../../payments/src/terms.ts";
import { loadProductIndex } from "../../../payments/src/webhook_core.ts";
import { hashEmail } from "../../../payments/src/provider.ts";

export interface ProcessWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export async function processBillingWebhookUseCase(
  req: ProcessWebhookRequest,
  adapters: PaymentProviderPort[]
): Promise<void> {
  // 1. Signature-based Routing
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

  // 2. Strict Zod-enforced Validation
  const validation = await matchedAdapter.parseAndValidateWebhook(req.headers, req.body);
  
  if (!validation.isValid || !validation.event) {
    throw new Error(`Webhook validation failed for ${matchedAdapter.providerName}: ${validation.error}`);
  }

  const { event } = validation;

  // 3. Domain Logic Execution (Ledger append)
  if (event.eventType === "refund_issued") {
    // Write to ledger
    await appendRefund({
      provider: event.provider as any,
      sale_id: event.saleId,
      ts: event.timestamp
    });
    return;
  }

  if (event.eventType === "sale_completed") {
    // 3a. Resolve Product Config to figure out creator cuts and metadata
    const cfg = loadProductIndex().get(event.productId);
    if (!cfg) {
      throw new Error(`Unknown product_id: ${event.productId}`);
    }

    // 3b. Compute Split
    const creatorPct = effectiveCreatorSplitPct(cfg.creator_id, cfg.product_id, event.timestamp);
    if (creatorPct === null) {
      throw new Error(`Could not resolve split percentage for creator ${cfg.creator_id}`);
    }
    
    const split = computeSplit(event.totalCents / 100, creatorPct); // amount_usd expected by split

    // 3c. Append to ledger
    await appendSale({
      sale_id: event.saleId,
      provider: event.provider as any,
      product_id: event.productId,
      amount_usd: event.totalCents / 100,
      ts: event.timestamp,
      email_hash: hashEmail(event.email),
      creator_id: cfg.creator_id,
      creator_split_pct: creatorPct,
      creator_split_usd: split.creator_split_usd,
      our_split_usd: split.our_split_usd,
      currency: cfg.currency
    });
  }
}
