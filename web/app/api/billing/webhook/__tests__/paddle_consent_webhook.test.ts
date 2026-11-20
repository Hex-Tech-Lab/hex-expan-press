// End-to-end Paddle webhook -> orders.buyer_email_consent persistence test (PR #138 P1-b verification).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import type { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ upserts: [] as Array<Record<string, unknown>> }));
const ledgerDir = vi.hoisted(() => `/tmp/paddle-consent-wh-${Date.now()}-${globalThis.crypto.randomUUID()}`);

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const makeUpdate = () => ({
        eq: () => makeUpdate(),
        lte: () => makeUpdate(),
        select: async () => ({ data: [] as unknown[], error: null }),
      });
      return {
        upsert: async (row: Record<string, unknown>) => {
          if (table === "orders") db.upserts.push(row);
          return { error: null };
        },
        update: () => makeUpdate(),
        insert: (row: Record<string, unknown>) => {
          if (table === "orders") db.upserts.push(row);
          const insertResult = Promise.resolve({ error: null });
          return Object.assign(insertResult, { abortSignal: () => insertResult });
        },
        select: () => ({
          eq: function eq() {
            return {
              eq,
              in: eq,
              abortSignal() {
                return this;
              },
              maybeSingle: async () => ({ data: null, error: null }),
            };
          },
        }),
      };
    },
  }),
}));

vi.mock("../../../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: { setnx: async () => 1, incr: async () => 1, compareAndDel: async () => 1, del: async () => 1 },
}));

vi.mock("../../../../../../payments/src/webhook_core.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../../payments/src/webhook_core.ts")>()),
  resolveProductByAlias: (alias: string) =>
    alias === "prod_paddle_consent"
      ? Promise.resolve({ productId: "prod_paddle_consent", creatorHandle: "c1", currency: "USD", checkoutMode: "live" })
      : Promise.resolve(null),
}));

vi.mock("../../../../../../payments/src/terms.ts", () => ({
  effectiveCreatorSplitPct: () => 50,
  effectiveCreatorSplitPctAsync: () => Promise.resolve(50),
}));

vi.mock("../../../../../../payments/src/delivery.ts", () => ({
  deliverSaleForWebhook: async () => undefined,
  saleDeliveryConfirmed: async () => false,
}));

vi.mock("../../../../../../payments/src/settings_registry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/settings_registry")>();
  return {
    ...actual,
    GLOBAL: {
      ...actual.GLOBAL,
      paths: { ...actual.GLOBAL.paths, sales_ledger: `${ledgerDir}/sales.jsonl` },
    },
    isMoneyPath: () => false,
  };
});

import { GLOBAL } from "../../../../../../payments/src/settings_registry";
import { createWebhookHandler } from "../handler";
import { routableVerifiers } from "../verifiers";

const PADDLE_SECRET = crypto.randomBytes(16).toString("hex");
const POST = createWebhookHandler(() => routableVerifiers());

function signPaddle(ts: string, body: string): string {
  const h1 = crypto.createHmac("sha256", Buffer.from(PADDLE_SECRET, "utf8")).update(`${ts}:${body}`, "utf8").digest("hex");
  return `ts=${ts};h1=${h1}`;
}

describe("Paddle webhook handler -> orders.buyer_email_consent persistence", () => {
  beforeEach(() => {
    db.upserts = [];
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("PADDLE_WEBHOOK_SECRET", PADDLE_SECRET);
    vi.stubEnv("PADDLE_ENVIRONMENT", "production");
    vi.stubEnv("PADDLE_PRICE_MAP", JSON.stringify({ pri_consent_1: "prod_paddle_consent" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it.each([
    ["true", true, false],
    ["false", false, false],
    [true, true, false],
    [false, false, false],
    ["yes", null, true],
    [undefined, null, false],
  ] as const)(
    "persists custom_data[buyer_consent_key]=%j as orders.buyer_email_consent=%s",
    async (rawConsent, expectedDbValue, expectWarn) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consentKey = GLOBAL.payments.paddle.overlay.buyer_consent_key;
      const customData: Record<string, unknown> = {
        product_id: "prod_paddle_consent",
        email: "buyer@example.com",
      };
      if (rawConsent !== undefined) {
        customData[consentKey] = rawConsent;
      }
      const body = JSON.stringify({
        event_type: "transaction.completed",
        data: {
          id: `txn_consent_${String(rawConsent)}`,
          currency_code: "USD",
          details: { totals: { total: "900" } },
          items: [{ price: { id: "pri_consent_1" } }],
          custom_data: customData,
          changed_at: "2026-11-20T00:00:00.000Z",
        },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const res = await POST(
        new Request("https://expanpress.com/api/billing/webhook", {
          method: "POST",
          headers: { "paddle-signature": signPaddle(ts, body), "content-type": "application/json" },
          body,
        }) as unknown as NextRequest,
      );

      expect(res.status).toBe(200);
      expect(db.upserts).toHaveLength(1);
      expect(db.upserts[0]?.buyer_email_consent).toBe(expectedDbValue);
      if (expectWarn) {
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(consentKey));
      } else {
        expect(warnSpy).not.toHaveBeenCalled();
      }
    },
  );
});
