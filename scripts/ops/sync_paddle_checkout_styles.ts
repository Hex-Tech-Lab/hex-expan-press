import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL } from "../../payments/src/settings_registry.ts";
import { buildPaddleCheckoutStylesPayload } from "../../payments/src/checkout_branding.ts";

export interface SyncPaddleStylesResult {
  apiBase: string;
  payload: ReturnType<typeof buildPaddleCheckoutStylesPayload>;
  applied: boolean;
}

export async function syncPaddleCheckoutStyles(options: {
  apply?: boolean;
  sandbox?: boolean;
  apiKey?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<SyncPaddleStylesResult> {
  const apply = options.apply === true;
  const apiBase = (options.sandbox ? GLOBAL.payments.paddle.api_base.sandbox : GLOBAL.payments.paddle.api_base.production).replace(/\/$/, "");
  const payload = buildPaddleCheckoutStylesPayload(GLOBAL.branding);

  if (!apply) {
    return { apiBase, payload, applied: false };
  }

  const apiKey = options.apiKey ?? process.env.PADDLE_API_KEY;
  if (!apiKey) {
    throw new Error("PADDLE_API_KEY is required when --apply is passed");
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const timeoutMs = GLOBAL.payments.sync_http_timeout_ms;

  const stylesResp = await fetchFn(`${apiBase}/checkout-styles`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload.checkoutStyles),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!stylesResp.ok) {
    throw new Error(`Paddle PATCH /checkout-styles failed: HTTP ${stylesResp.status}`);
  }

  const overlayResp = await fetchFn(`${apiBase}/settings/checkout-styles-overlay`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload.overlayStyles),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!overlayResp.ok) {
    throw new Error(`Paddle PATCH /settings/checkout-styles-overlay failed: HTTP ${overlayResp.status}`);
  }

  return { apiBase, payload, applied: true };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const sandbox = process.argv.includes("--sandbox");
  const result = await syncPaddleCheckoutStyles({ apply, sandbox });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
