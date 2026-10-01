// Fail-closed contract tests for the Firma adapter (Wave 5.1, qa-intel
// security rule: the HMAC gate here is authorization-relevant and needs a
// sibling regression test).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { FirmaAdapter } from "../firma.adapter";

const SECRET = "test-webhook-secret";

function signedBody(payload: unknown, secret = SECRET): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { body, headers: { "x-firma-signature": signature, "content-type": "application/json" } };
}

function completedPayload(metadata: Record<string, string>): unknown {
  return {
    type: "signing_request.completed",
    data: { signing_request: { id: "env_123", document_sha256: "abc123hash", metadata } },
  };
}

describe("FirmaAdapter.parseAndValidateWebhook (fail-closed HMAC gate)", () => {
  beforeEach(() => {
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("FAILS CLOSED when FIRMA_WEBHOOK_SECRET is unconfigured — unsigned payload rejected", async () => {
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", "");
    const adapter = new FirmaAdapter();
    const result = await adapter.parseAndValidateWebhook(
      JSON.stringify(completedPayload({ productId: "p1", userId: "u1" })),
      { "content-type": "application/json" },
    );
    expect(result.isValid).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("FAILS CLOSED for a correctly SIGNED payload when the secret is unconfigured", async () => {
    // No skip-HMAC downgrade path exists: a valid signature cannot rescue a
    // request when the secret is missing — the endpoint rejects regardless.
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", "");
    const adapter = new FirmaAdapter();
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }), SECRET);
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
  });

  it("rejects a wrong-secret signature while the secret is configured", async () => {
    const adapter = new FirmaAdapter();
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }), "attacker-secret");
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("accepts a validly-signed completed envelope and maps the event", async () => {
    const adapter = new FirmaAdapter();
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(true);
    expect(result.event?.eventType).toBe("envelope.completed");
    expect(result.event?.metadata).toEqual({ productId: "p1", userId: "u1" });
  });

  // Sharp-edges audit 2026-10-01: signature comparison is now constant-time
  // (timingSafeEqual over decoded hex bytes). Length-mismatched and non-hex
  // inputs must reject with the same "Invalid signature" result.
  it("rejects a MISSING signature header", async () => {
    const adapter = new FirmaAdapter();
    const { body } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    const result = await adapter.parseAndValidateWebhook(body, { "content-type": "application/json" });
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("rejects a WRONG-LENGTH signature without throwing", async () => {
    const adapter = new FirmaAdapter();
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    headers["x-firma-signature"] = "abcd";
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("rejects a NON-HEX signature without throwing", async () => {
    const adapter = new FirmaAdapter();
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    headers["x-firma-signature"] = "z".repeat(64);
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });
});
