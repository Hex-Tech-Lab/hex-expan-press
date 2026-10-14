// Terminal-reject quarantine for the esign webhook route (split from esign-webhook.test.ts).
import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { WebhookValidationError } from "../../../../src/domain/webhook/webhook_errors";

// Module mocks must live in each test file (vi.mock is hoisted per file).
// The esign use case builds its own adapter via the factory (whose default
// download transport is the undici pinned fetch — secure by default). For
// USE-CASE contract tests the download leg is routed back through the
// stubbed global fetch; the pinned transport itself is exercised against
// real local sockets in the adapter test file.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: ((url: string | URL | Request, init?: RequestInit) => fetch(url as string, init)) as unknown as typeof actual.fetch,
  };
});
// The adapter's default resolver is the platform DNS; these tests use fake
// hosts (.test TLD) that must not touch a real resolver. Mock at the module
// level so the FACTORY-built adapter (createEsignAdapter) resolves every
// hostname to a public address hermetically (sprint-12 DNS-level SSRF guard).
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34" }],
}));

describe("esign webhook route — terminal-reject quarantine (compiled sweep)", () => {
  it("a validation-failed delivery returns 400 and quarantines the event (sha256, no raw body)", async () => {
    vi.resetModules();
    const inserts: Array<{ event?: string; details?: Record<string, unknown> }> = [];
    vi.doMock("../../../../../../src/use_cases/process_esign_webhook", () => ({
      processEsignWebhookUseCase: vi.fn(() => {
        throw new WebhookValidationError("Webhook validation failed: completed envelope env_q has a missing or invalid document_sha256");
      }),
    }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: (table: string) => ({
          insert: (row: unknown) => {
            if (table === "audit_log") inserts.push(row as { event?: string; details?: Record<string, unknown> });
            const insertResult = Promise.resolve({ error: null });
            return Object.assign(insertResult, { abortSignal: () => insertResult });
          },
        }),
      }),
    }));
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", "route-secret");
    const { POST } = await import("../../../app/api/esign/webhook/route");
    const payload = JSON.stringify({ type: "signing_request.completed", data: { signing_request: { id: "env_q" } } });
    const signature = crypto.createHmac("sha256", "route-secret").update(payload).digest("hex");
    const req = new Request("https://expanpress.com/api/esign/webhook", {
      method: "POST",
      body: payload,
      headers: { "x-firma-signature": signature },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ event: "WEBHOOK_TERMINAL_REJECT", details: { provider: "esign", reason: "WebhookValidationError" } });
    expect(inserts[0]?.details?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an unauthenticated (401) reject returns 401 and does NOT quarantine", async () => {
    vi.resetModules();
    const inserts: Array<{ event?: string; details?: Record<string, unknown> }> = [];
    vi.doMock("../../../../../../src/use_cases/process_esign_webhook", () => ({
      processEsignWebhookUseCase: vi.fn(() => {
        throw new WebhookValidationError("Webhook validation failed: Invalid signature", 401);
      }),
    }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: (table: string) => ({
          insert: (row: unknown) => {
            if (table === "audit_log") inserts.push(row as { event?: string; details?: Record<string, unknown> });
            const insertResult = Promise.resolve({ error: null });
            return Object.assign(insertResult, { abortSignal: () => insertResult });
          },
        }),
      }),
    }));
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", "route-secret");
    const { POST } = await import("../../../app/api/esign/webhook/route");
    const payload = JSON.stringify({ type: "signing_request.completed", data: { signing_request: { id: "env_q" } } });
    const req = new Request("https://expanpress.com/api/esign/webhook", {
      method: "POST",
      body: payload,
      headers: { "x-firma-signature": "0".repeat(64) }, // present but wrong → 401
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(0); // unauthenticated senders must not force service-role audit writes
  });

  it("takes the audit IP from x-real-ip ahead of a spoofed x-forwarded-for", async () => {
    vi.resetModules();
    const processSpy = vi.fn(async () => undefined);
    vi.doMock("../../../../src/use_cases/process_esign_webhook", () => ({ processEsignWebhookUseCase: processSpy }));
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: () => ({
          insert: () => {
            const insertResult = Promise.resolve({ error: null });
            return Object.assign(insertResult, { abortSignal: () => insertResult });
          },
        }),
      }),
    }));
    vi.stubEnv("SUPABASE_URL", "https://unit.test.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-key");
    vi.stubEnv("FIRMA_WEBHOOK_SECRET", "route-secret");
    const { POST } = await import("../../../app/api/esign/webhook/route");
    const payload = JSON.stringify({ type: "signing_request.completed", data: { signing_request: { id: "env_ip" } } });
    const signature = crypto.createHmac("sha256", "route-secret").update(payload).digest("hex");
    const req = new Request("https://expanpress.com/api/esign/webhook", {
      method: "POST",
      body: payload,
      headers: { "x-firma-signature": signature, "x-real-ip": "198.51.100.7", "x-forwarded-for": "6.6.6.6" },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(processSpy).toHaveBeenCalledWith(expect.objectContaining({ ip: "198.51.100.7" }), expect.anything(), expect.anything());
  });
});
