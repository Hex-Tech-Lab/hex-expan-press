import type { IncomingMessage, ServerResponse } from "node:http";
import { processBillingWebhookUseCase } from "../../../src/use_cases/billing/process_billing_webhook.ts";

import { PolarAdapter } from "../../../src/adapters/payments/polar.adapter.ts";
import { PaddleAdapter } from "../../../src/adapters/payments/paddle.adapter.ts";
import { LegacyPaymentAdapterWrapper } from "../../../src/adapters/payments/legacy.adapter.ts";

import { lemonsqueezyProvider } from "../../../payments/src/providers/lemonsqueezy.ts";
import { payhipProvider } from "../../../payments/src/providers/payhip.ts";
import { fungiesProvider } from "../../../payments/src/providers/fungies.ts";
import { fastspringProvider } from "../../../payments/src/providers/fastspring.ts";

/**
 * Writes a JSON response through the legacy Node ServerResponse surface.
 */
function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/**
 * Legacy Vercel billing webhook handler (bridged into Next.js via shim.ts):
 * routes on provider signature evidence (never URL), validates via the
 * matching adapter (Zod SSOT for Polar/Paddle), then records the sale or
 * refund to the ledger. 405 non-POST, 400 validation, 500 unexpected.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });

  try {
    let body = "";
    for await (const chunk of req) body += chunk;

    // Load active adapters. 
    // Zod SSOT active for Polar and Paddle. 
    // Legacy bridge active for the rest, hunting down remaining tangents over time.
    const adapters = [
      new PolarAdapter(),
      new PaddleAdapter(),
      new LegacyPaymentAdapterWrapper(lemonsqueezyProvider),
      new LegacyPaymentAdapterWrapper(payhipProvider),
      new LegacyPaymentAdapterWrapper(fungiesProvider),
      new LegacyPaymentAdapterWrapper(fastspringProvider)
    ];

    await processBillingWebhookUseCase({ headers: req.headers, body }, adapters);

    return json(res, 200, { ok: true });
  } catch (err) {
    console.error("Billing webhook error:", err);
    const message = err instanceof Error ? err.message : String(err);
    const isValidationErr = message.includes("validation failed") || message.includes("No payment provider");
    return json(res, isValidationErr ? 400 : 500, { ok: false, error: message });
  }
}
