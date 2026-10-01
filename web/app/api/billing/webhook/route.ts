import { NextRequest, NextResponse } from "next/server";
import { processBillingWebhookUseCase } from "../../../../../src/use_cases/billing/process_billing_webhook";
import { PolarAdapter } from "../../../../../src/adapters/payments/polar.adapter";
import { PaddleAdapter } from "../../../../../src/adapters/payments/paddle.adapter";
import { LegacyPaymentAdapterWrapper } from "../../../../../src/adapters/payments/legacy.adapter";
import { fungiesProvider } from "../../../../../payments/src/providers/fungies";

export const runtime = "nodejs";

// Webhooks are small JSON bodies (KBs) — cap buffering at 1 MiB (the Wave 4
// contract carried over from the shim era) so a flood of oversized POSTs
// cannot create memory pressure.
const MAX_BODY_BYTES = 1_048_576;

/** Streams the request body with the byte cap enforced mid-read. */
async function readBodyCapped(request: NextRequest): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Billing webhook (Wave 6, native route handler — replaces the shim-bridged
 * legacy handler). Signature-based provider routing with strict HMAC
 * verification (fail-closed, verified in Wave 5.1); raw body comes from
 * request.text() byte-exactly.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const bodyBuffer = await readBodyCapped(request);
  if (bodyBuffer === null) {
    return NextResponse.json({ ok: false, error: "Payload Too Large" }, { status: 413 });
  }
  const body = bodyBuffer.toString("utf8");
  const headers = Object.fromEntries(request.headers);

  // Only providers we sell through are routable (Polar, Paddle, Fungies);
  // every other verifier is unreachable by design (sharp-edges audit
  // 2026-10-01). Add a provider here only with a reviewed verifier.
  const adapters = [new PolarAdapter(), new PaddleAdapter(), new LegacyPaymentAdapterWrapper(fungiesProvider)];

  try {
    await processBillingWebhookUseCase({ headers, body }, adapters);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Another delivery of this event holds the idempotency lock and has not
    // persisted yet — never 200 here (the holder may still fail). 503 +
    // Retry-After makes the provider redeliver.
    if (err instanceof Error && err.name === "WebhookInFlightError") {
      return NextResponse.json(
        { ok: false, error: "In flight — retry" },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }
    console.error("Billing webhook error:", err);
    const message = err instanceof Error ? err.message : String(err);
    const isValidationErr = message.includes("validation failed") || message.includes("No payment provider");
    // The use case attaches httpStatus to validation failures (e.g. 401 for a
    // bad/stale signature) — honor it when in the 4xx band; otherwise the
    // legacy 400/500 split stands.
    const rawStatus = (err as { httpStatus?: unknown })?.httpStatus;
    // 4xx from the adapter is final; 503 asks the provider to RETRY (e.g. Paddle buyer-email lookup failed) — never flatten it to 400.
    const httpStatus = typeof rawStatus === "number" && ((rawStatus >= 400 && rawStatus < 500) || rawStatus === 503) ? rawStatus : undefined;
    const status = isValidationErr && httpStatus === undefined ? 400 : httpStatus ?? (isValidationErr ? 400 : 500);
    const error = status === 401 ? "Unauthorized" : status === 503 ? "Temporarily unavailable — retry" : status === 500 ? "Internal Server Error" : "Bad Request";
    return NextResponse.json({ ok: false, error }, { status });
  }
}
