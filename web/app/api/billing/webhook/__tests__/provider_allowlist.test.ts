// Sharp-edges audit 2026-10-01: the webhook route routes by first header match
// over an adapter allowlist. Payhip's "verifier" is a static hash of the API
// key (not body-covering), so the routable set was narrowed to ONLY the
// providers we actually sell through (Polar, Fungies). These tests prove the
// excluded verifiers are unreachable: even a fully valid Payhip/LemonSqueezy
// signature over a sale-shaped payload must NOT be accepted as a sale — no
// ledger row, no order/audit write, no idempotency lock.
//
// Mocking pattern follows the sibling tests (polar-partial-refund.test.ts):
// Supabase writes are captured, the distributed lock is a spy, and the
// settings registry points the sales ledger at a throwaway temp file.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";

const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";
// Per-run random fixture keys: nothing credential-shaped is committed.
const LS_SECRET = crypto.randomBytes(16).toString("hex");
const PAYHIP_SECRET = crypto.randomBytes(16).toString("hex");

// Supabase is faked: EVERY insert/upsert on ANY table is captured — the
// allowlist must produce zero writes anywhere.
const supa = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; row: unknown }>,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: async (row: unknown) => {
        supa.writes.push({ table, row });
        return { error: null };
      },
      upsert: async (row: unknown) => {
        supa.writes.push({ table, row });
        return { error: null };
      },
      select: () => {
        const eq = () => ({ eq, maybeSingle: async () => ({ data: null, error: null }) });
        return { eq };
      },
    }),
  }),
}));

// Distributed lock is a spy: a rejected request must never reach the lock.
const setnx = vi.fn<(...args: unknown[]) => Promise<number>>();
vi.mock("../../../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: {
    setnx: (...a: unknown[]) => setnx(...a),
    del: vi.fn(() => Promise.resolve(1)),
  },
}));

// Point the registry module at a temp ledger path — tests never touch data/db.
const salesFileDir = vi.hoisted(() => `/tmp/allowlist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const salesFilePath = vi.hoisted(() => `${salesFileDir}/sales.jsonl`);

vi.mock("../../../../../../payments/src/settings_registry.ts", () => ({
  GLOBAL: { paths: { sales_ledger: salesFilePath } },
  expandHome: (p: string, home: string) => (home && (p === "~" || p.startsWith("~/")) ? p : p),
  isRegisteredPaymentProvider: (name: unknown) => typeof name === "string",
  paymentProviderSetting: () => undefined,
}));

// A realistic Lemon Squeezy order_created whose X-Signature is a VALID
// HMAC-SHA256 hex digest over the raw body (their documented scheme). Before
// the allowlist this request routed to lemonsqueezyProvider and verified.
const LS_PAYLOAD = JSON.stringify({
  meta: { event_name: "order_created", custom_data: { product_id: "test_product_v1" } },
  data: {
    id: "ord_ls_allowlist_1",
    attributes: {
      total: 1000,
      currency: "usd",
      user_email: "buyer@example.com",
      created_at: "2026-10-01T00:00:00.000Z",
      identifier: "ord_ls_allowlist_1",
    },
  },
});

// A realistic Payhip `paid` event whose `signature` body field equals
// sha256(Payhip API key) — fully valid under Payhip's (body-blind) scheme.
const PAYHIP_PAYLOAD = JSON.stringify({
  id: "tx_payhip_allowlist_1",
  type: "paid",
  email: "buyer@example.com",
  currency: "USD",
  price: 1000,
  items: [{ product_id: "test_product_v1" }],
  date: Math.floor(Date.now() / 1000),
  signature: crypto.createHash("sha256").update(PAYHIP_SECRET, "utf8").digest("hex"),
});

function ledgerRows(): string[] {
  if (!existsSync(salesFilePath)) return [];
  return readFileSync(salesFilePath, "utf8").split(/\r?\n/).filter(Boolean);
}

describe("billing webhook provider allowlist (sharp-edges audit 2026-10-01)", () => {
  beforeEach(() => {
    setnx.mockReset();
    setnx.mockResolvedValue(1);
    supa.writes = [];
    mkdirSync(salesFileDir, { recursive: true });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unit.test.redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
  });

  afterEach(() => {
    rmSync(salesFileDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("a VALIDLY LemonSqueezy-signed order_created is NOT accepted as a sale (400, no ledger/order write, no lock)", async () => {
    vi.stubEnv("LEMONSQUEEZY_WEBHOOK_SECRET", LS_SECRET);
    const sig = crypto.createHmac("sha256", Buffer.from(LS_SECRET, "utf8")).update(LS_PAYLOAD).digest("hex");
    const res = await billingPost(
      asNextRequest(
        new Request(WEBHOOK_URL, {
          method: "POST",
          headers: { "x-signature": sig, "content-type": "application/json" },
          body: LS_PAYLOAD,
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(supa.writes).toHaveLength(0);
    expect(ledgerRows()).toHaveLength(0);
    expect(setnx).not.toHaveBeenCalled();
  });

  it("a Payhip-style request (static signature in the body) is NOT accepted as a sale (400, no ledger/order write, no lock)", async () => {
    vi.stubEnv("PAYHIP_WEBHOOK_SECRET", PAYHIP_SECRET);
    const res = await billingPost(
      asNextRequest(
        new Request(WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: PAYHIP_PAYLOAD,
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(supa.writes).toHaveLength(0);
    expect(ledgerRows()).toHaveLength(0);
    expect(setnx).not.toHaveBeenCalled();
  });

  it("positive control: a Polar-signed delivery still routes through the narrowed allowlist (200 on an ignored unpaid order.created)", async () => {
    vi.stubEnv("POLAR_WEBHOOK_SECRET", crypto.randomBytes(16).toString("hex"));
    const id = "whid_allowlist_0001";
    const ts = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({
      type: "order.created",
      data: {
        id: "ord_allowlist_ctrl_1",
        paid: false,
        total_amount: 0,
        currency: "usd",
        created_at: "2026-10-01T00:00:00.000Z",
        customer: { email: "buyer@example.com" },
      },
    });
    const sig = crypto
      .createHmac("sha256", Buffer.from(crypto.randomBytes(16).toString("hex"), "utf8"))
      .update(`${id}.${ts}.${payload}`)
      .digest("base64");
    const res = await billingPost(
      asNextRequest(
        new Request(WEBHOOK_URL, {
          method: "POST",
          headers: {
            "webhook-id": id,
            "webhook-timestamp": ts,
            "webhook-signature": `v1,${sig}`,
            "content-type": "application/json",
          },
          body: payload,
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(supa.writes).toHaveLength(0);
    expect(ledgerRows()).toHaveLength(0);
  });
});
