// Paddle webhook verifier regression tests (ADR-0050 hardening): timestamp
// freshness is enforced BEFORE HMAC verification (5-minute tolerance,
// fail-closed), h1 must be exactly 64 hex chars, and multiple h1 values
// (secret rotation) are accepted when ANY valid-format one matches.
// Per-run random secret: nothing credential-shaped is committed.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import crypto, { createHash } from "node:crypto";
import { PaddleAdapter, PADDLE_WEBHOOK_TOLERANCE_SECONDS, loadPaddlePriceMap, paddleServerEnvironment } from "../paddle.adapter.ts";
import type { SaleCompletedEvent } from "../../../domain/payments/payments.port.ts";

const SECRET = crypto.randomBytes(16).toString("hex");

const DEFAULT_PRICE_MAP = JSON.stringify({
  pri_test_basic: "test_product_basic",
  pri_test_premium: "test_product_premium",
});

const hmacFor = (ts: string, body: string, secret = SECRET): string =>
  crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(`${ts}:${body}`, "utf8").digest("hex");

const validBody = (overrides?: {
  items?: Array<{ price: { id: string } }>;
  custom_data?: { product_id?: string; email?: string };
}): string =>
  JSON.stringify({
    event_type: "transaction.completed",
    data: {
      id: "txn_test_0001",
      currency_code: "USD",
      details: { totals: { total: "1000" } },
      items: overrides?.items ?? [{ price: { id: "pri_test_basic" } }],
      custom_data: overrides?.custom_data !== undefined
        ? overrides.custom_data
        : { product_id: "test_product_basic", email: "buyer@example.com" },
      changed_at: new Date().toISOString(),
    },
  });

const bodyWithCustomer = (
  customerId?: string,
  withEmail = false,
  items: Array<{ price: { id: string } }> = [{ price: { id: "pri_test_basic" } }]
): string =>
  JSON.stringify({
    event_type: "transaction.completed",
    data: {
      id: "txn_test_0001",
      currency_code: "USD",
      details: { totals: { total: "1000" } },
      items,
      custom_data: { product_id: "test_product_basic", ...(withEmail ? { email: "buyer@example.com" } : {}) },
      customer_id: customerId,
      changed_at: new Date().toISOString(),
    },
  });

const jsonOk = (email: string): unknown => ({ data: { id: "ctm_1", email } });
const fetchOk = (email: string): unknown => vi.fn(async () => ({ ok: true, status: 200, json: async () => jsonOk(email) }));

const headersFor = (sig: string): Record<string, string> => ({ "paddle-signature": sig });

async function parse(body: string, sig: string, secret?: string): Promise<Awaited<ReturnType<PaddleAdapter["parseAndValidateWebhook"]>>> {
  vi.stubEnv("PADDLE_WEBHOOK_SECRET", secret ?? SECRET);
  return new PaddleAdapter().parseAndValidateWebhook(headersFor(sig), body);
}

function freshSig(body: string, secret = SECRET): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  return `ts=${ts};h1=${hmacFor(ts, body, secret)}`;
}

describe("PaddleAdapter webhook verification (tolerance + h1 format)", () => {
  beforeEach(() => {
    vi.stubEnv("PADDLE_ENVIRONMENT", "sandbox");
    vi.stubEnv("PADDLE_PRICE_MAP", DEFAULT_PRICE_MAP);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("PADDLE_WEBHOOK_TOLERANCE_SECONDS is 300", () => {
    expect(PADDLE_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
  });

  it("a valid transaction.completed maps the sale fields", async () => {
    const body = validBody();
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    const event = (res as { event: SaleCompletedEvent }).event;
    expect(event.eventType).toBe("sale_completed");
    expect(event.providerName).toBe("paddle");
    expect(event.saleId).toBe("txn_test_0001");
    expect(event.productId).toBe("test_product_basic");
    expect(event.totalCents).toBe(1000);
    expect(event.currency).toBe("USD");
    expect(event.buyerEmailHash).toBe(createHash("sha256").update("buyer@example.com").digest("hex"));
  });

  it.each([
    ["301s old", () => (Math.floor(Date.now() / 1000) - 301).toString()],
    ["301s future", () => (Math.floor(Date.now() / 1000) + 301).toString()],
    ["non-integer (decimal)", () => `${Math.floor(Date.now() / 1000)}.5`],
    ["non-integer (junk)", () => "not-a-number"],
  ])("ts %s → 401 outside the 5-minute tolerance", async (_label, ts) => {
    const body = validBody();
    const res = await parse(body, `ts=${ts()};h1=${hmacFor("0", body)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
    expect((res as { error?: string }).error).toBe("Webhook timestamp outside the 5-minute tolerance");
  });

  it("a wrong h1 → 401 Invalid Paddle signature", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${"a".repeat(64)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
    expect((res as { error?: string }).error).toBe("Invalid Paddle signature");
  });

  it("a valid h1 with a junk 'z' suffix → 401 (64-hex format gate, no silent truncation)", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${hmacFor(ts, body)}z`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
  });

  it("an h1 shorter than 64 hex chars → 401", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${hmacFor(ts, body).slice(0, 63)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
  });

  it("two h1 values where the SECOND is correct → valid (secret rotation)", async () => {
    const body = validBody();
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${"b".repeat(64)};h1=${hmacFor(ts, body)}`);
    expect(res.isValid).toBe(true);
    expect((res as { event: SaleCompletedEvent }).event.eventType).toBe("sale_completed");
  });

  it("missing h1 entirely → 401 malformed header", async () => {
    const body = validBody();
    const res = await parse(body, `ts=${Math.floor(Date.now() / 1000)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
  });

  it("missing PADDLE_WEBHOOK_SECRET → 500 (never verify against an empty secret)", async () => {
    const body = validBody();
    const res = await parse(body, freshSig(body), "");
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(500);
  });

  it("a non-transaction.completed event verifies but is NOT a sale (ignored event)", async () => {
    const body = JSON.stringify({
      event_type: "order.created",
      data: { id: "txn_test_0002", custom_data: { product_id: "test_product_basic", email: "buyer@example.com" } },
    });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    const event = (res as { event: { eventType: string } }).event;
    expect(event.eventType).not.toBe("sale_completed");
    expect(event.eventType).toBe("ignored");
  });
});

describe("PaddleAdapter server environment & price map hardening", () => {
  beforeEach(() => {
    vi.stubEnv("PADDLE_ENVIRONMENT", "sandbox");
    vi.stubEnv("PADDLE_PRICE_MAP", DEFAULT_PRICE_MAP);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("loadPaddlePriceMap parses valid JSON map and returns null on invalid", () => {
    expect(loadPaddlePriceMap(JSON.stringify({ a: "1", b: "2" }))).toEqual({ a: "1", b: "2" });
    expect(loadPaddlePriceMap("")).toBeNull();
    expect(loadPaddlePriceMap("not-json")).toBeNull();
    expect(loadPaddlePriceMap(JSON.stringify(["a", "b"]))).toBeNull();
    expect(loadPaddlePriceMap(JSON.stringify({ a: 123 }))).toBeNull();
    vi.stubEnv("PADDLE_PRICE_MAP", "");
    expect(loadPaddlePriceMap()).toBeNull();
  });

  it("paddleServerEnvironment validates sandbox and production rules", () => {
    expect(paddleServerEnvironment("sandbox", undefined)).toBe("sandbox");
    expect(paddleServerEnvironment("production", undefined)).toBe("production");
    expect(paddleServerEnvironment("production", "production")).toBe("production");
    expect(paddleServerEnvironment("sandbox", "production")).toBeNull();
    expect(paddleServerEnvironment("other", undefined)).toBeNull();
    vi.stubEnv("PADDLE_ENVIRONMENT", "");
    expect(paddleServerEnvironment()).toBeNull();
  });

  it("mapped price → that product", async () => {
    const body = validBody({
      items: [{ price: { id: "pri_test_premium" } }],
      custom_data: { email: "buyer@example.com" },
    });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    const event = (res as { event: SaleCompletedEvent }).event;
    expect(event.productId).toBe("test_product_premium");
  });

  it("cheap price + custom_data.product_id of premium product → 400 mismatch", async () => {
    const body = validBody({
      items: [{ price: { id: "pri_test_basic" } }],
      custom_data: { product_id: "test_product_premium", email: "buyer@example.com" },
    });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
    expect((res as { error?: string }).error).toBe("custom_data.product_id does not match the paid price");
  });

  it("unknown price → 400", async () => {
    const body = validBody({
      items: [{ price: { id: "pri_unknown" } }],
    });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
    expect((res as { error?: string }).error).toBe("Unknown Paddle price");
  });

  it.each([["constructor"], ["__proto__"], ["toString"]])("prototype-named price id %j → 400 (own-property lookup)", async (priceId) => {
    const body = validBody({ items: [{ price: { id: priceId } }] });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
    expect((res as { error?: string }).error).toBe("Unknown Paddle price");
  });

  it("zero items → 400", async () => {
    const body = validBody({ items: [] });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
    expect((res as { error?: string }).error).toBe("Unknown Paddle price");
  });

  it("two items mapping to two products → 400", async () => {
    const body = validBody({
      items: [
        { price: { id: "pri_test_basic" } },
        { price: { id: "pri_test_premium" } },
      ],
    });
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
    expect((res as { error?: string }).error).toBe("Mixed products in one transaction");
  });

  it("missing PADDLE_PRICE_MAP → 500", async () => {
    vi.stubEnv("PADDLE_PRICE_MAP", "");
    const body = validBody();
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(500);
    expect((res as { error?: string }).error).toBe("PADDLE_PRICE_MAP not configured");
  });

  it("invalid PADDLE_PRICE_MAP → 500", async () => {
    vi.stubEnv("PADDLE_PRICE_MAP", "{invalid-json");
    const body = validBody();
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(500);
    expect((res as { error?: string }).error).toBe("PADDLE_PRICE_MAP not configured");
  });

  it("PADDLE_ENVIRONMENT missing → 500", async () => {
    vi.stubEnv("PADDLE_ENVIRONMENT", "");
    const body = validBody();
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(500);
    expect((res as { error?: string }).error).toBe("PADDLE_ENVIRONMENT missing, unknown, or sandbox in production");
  });

  it("PADDLE_ENVIRONMENT=sandbox with VERCEL_ENV=production → 500", async () => {
    vi.stubEnv("PADDLE_ENVIRONMENT", "sandbox");
    vi.stubEnv("VERCEL_ENV", "production");
    const body = validBody();
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(500);
    expect((res as { error?: string }).error).toBe("PADDLE_ENVIRONMENT missing, unknown, or sandbox in production");
  });
});

describe("PaddleAdapter buyer-email fallback (customer lookup)", () => {
  const KEY = crypto.randomBytes(16).toString("hex");

  beforeEach(() => {
    vi.stubEnv("PADDLE_ENVIRONMENT", "sandbox");
    vi.stubEnv("PADDLE_PRICE_MAP", DEFAULT_PRICE_MAP);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("email present in custom_data → sale mapped, fetch NOT called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = validBody();
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("email absent + customer_id → fetch sandbox URL with bearer header, sale mapped with fetched email", async () => {
    vi.stubEnv("PADDLE_API_KEY", KEY);
    vi.stubEnv("PADDLE_ENVIRONMENT", "sandbox");
    const fetchedEmail = `buyer_${crypto.randomBytes(4).toString("hex")}@example.com`;
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => jsonOk(fetchedEmail) }));
    vi.stubGlobal("fetch", fetchMock);
    const body = bodyWithCustomer("ctm_test_0001");
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox-api.paddle.com/customers/ctm_test_0001");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const event = (res as { event: SaleCompletedEvent }).event;
    expect(event.buyerEmailHash).toBe(createHash("sha256").update(fetchedEmail).digest("hex"));
  });

  it("production env → api.paddle.com URL", async () => {
    vi.stubEnv("PADDLE_API_KEY", KEY);
    vi.stubEnv("PADDLE_ENVIRONMENT", "production");
    const fetchMock = fetchOk("buyer@example.com") as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock);
    const body = bodyWithCustomer("ctm_test_0001");
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.paddle.com/customers/ctm_test_0001");
  });

  it("fetch rejects → 503 Could not resolve buyer email", async () => {
    vi.stubEnv("PADDLE_API_KEY", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const body = bodyWithCustomer("ctm_test_0001");
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(503);
    expect((res as { error?: string }).error).toBe("Could not resolve buyer email from Paddle");
  });

  it("fetch 404 → 503 Could not resolve buyer email", async () => {
    vi.stubEnv("PADDLE_API_KEY", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: {} }) })));
    const body = bodyWithCustomer("ctm_test_0001");
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(503);
    expect((res as { error?: string }).error).toBe("Could not resolve buyer email from Paddle");
  });

  it("no email AND no customer_id → 400 (unchanged)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = bodyWithCustomer(undefined);
    const res = await parse(body, freshSig(body));
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(400);
    expect((res as { error?: string }).error).toBe("Missing custom_data.email in Paddle payload");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalid signature → fetch NOT called (never call Paddle for unverified payloads)", async () => {
    vi.stubEnv("PADDLE_API_KEY", KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = bodyWithCustomer("ctm_test_0001");
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await parse(body, `ts=${ts};h1=${"a".repeat(64)}`);
    expect(res.isValid).toBe(false);
    expect((res as { httpStatus?: number }).httpStatus).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

