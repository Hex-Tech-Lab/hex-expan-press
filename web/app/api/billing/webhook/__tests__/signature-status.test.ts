// Polar ships switched off (payments/src/settings_registry.ts, enabled: false). The
// Polar verifier is what these tests exercise, so this file switches it on. The
// switched-off behaviour is pinned separately in polar-switched-off.test.ts.
vi.mock("../../../../../../payments/src/settings_registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/settings_registry")>();
  return { ...actual, isEnabledPaymentProvider: (name: string) => name === "polar" || actual.isEnabledPaymentProvider(name) };
});

// A Polar request whose signature does NOT verify (wrong/stale secret) must
// answer 401 — the use case attaches httpStatus:401 to signature-validation
// failures and the route must honor it instead of the legacy flat 400.
import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { standardWebhookHeaders } from "./support/webhook_signer";
import type { NextRequest } from "next/server";
import { POST as billingPost } from "../route";

const asNextRequest = (req: Request): NextRequest => req as unknown as NextRequest;

const WEBHOOK_URL = "http://localhost:3000/api/billing/webhook";

// Per-run random secrets — never string-literal test secrets.
const SECRET_A = crypto.randomBytes(32).toString("hex");
const SECRET_B = crypto.randomBytes(32).toString("hex");

function signedHeaders(payload: string, key: string) {
  const id = `whid_${crypto.randomBytes(8).toString("hex")}`;
  return {
    ...standardWebhookHeaders(key, id, payload),
    "content-type": "application/json",
  };
}

// Neutral, non-production-shaped payload; unpaid order.created routes to
// "ignored" after signature verification — so a 401 here isolates signature
// validation alone.
const PAYLOAD = JSON.stringify({
  type: "order.created",
  data: {
    id: "ord_sigtest_neutral",
    paid: false,
    total_amount: 0,
    currency: "usd",
    created_at: "2026-09-28T00:00:00.000Z",
    customer: { email: "buyer@example.com", name: "Test Buyer" },
  },
});

describe("billing webhook signature status codes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a Polar request signed with the WRONG secret gets 401", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLAR_WEBHOOK_SECRET", SECRET_A);
    const res = await billingPost(
      asNextRequest(new Request(WEBHOOK_URL, { method: "POST", headers: signedHeaders(PAYLOAD, SECRET_B), body: PAYLOAD })),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
  });
});
