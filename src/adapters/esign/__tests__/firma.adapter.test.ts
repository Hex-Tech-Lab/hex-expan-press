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

  // Buffer.from(hex) truncates at junk / an unmatched final digit — a valid
  // signature with a suffix must still be rejected (CodeRabbit, PR #24).
  it.each([["z"], ["a"]])("rejects a VALID signature followed by %j", async (suffix) => {
    const adapter = new FirmaAdapter();
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    headers["x-firma-signature"] = String(headers["x-firma-signature"]) + suffix;
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });
});

// ---------------------------------------------------------------------------
// Sprint-10 F1: evidence port. The signed PDF must be retrievable and the
// consent-evidence object must upload + verify in Supabase Storage before any
// consent row is persisted. All fetches are stubbed — never hit the network.
// ---------------------------------------------------------------------------
const SUPABASE_URL = "https://unit.test.supabase.co";
const SUPABASE_KEY = "unit-test-key";
const EVIDENCE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status });
}

function bytesResponse(status: number, bytes: Uint8Array): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status });
}

describe("FirmaAdapter.fetchCompletedDocument (F1, LIVE-VERIFIED 2026-10-05)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // Live-verified contract (sprint 12): /documents and /documents/download are
  // 404 NOT_FOUND; the resource JSON carries document_url (a freshly-minted
  // signed Storage URL, ~1h TTL) and final_document_download_url (null on
  // unfinished requests — populated form UNVERIFIED, preferred when non-empty).
  const RESOURCE_URL = "https://api.firma.dev/functions/v1/signing-request-api/signing-requests/env_doc_1";
  const SIGNED_URL = "https://storage.firma.test/object/sign/consents/doc.pdf?token=jwt";
  const FINAL_URL = "https://storage.firma.test/object/sign/consents/final.pdf?token=jwt";

  function resourceResponse(overrides: Record<string, unknown> = {}): Response {
    return jsonResponse(200, { id: "env_doc_1", final_document_download_url: null, document_url: SIGNED_URL, ...overrides });
  }

  it("two-step flow: GET resource JSON → GET signed URL bytes, no Bearer forwarded to the signed URL", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    const bytes = await adapter.fetchCompletedDocument("env_doc_1");

    expect(bytes).toEqual(EVIDENCE_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [resourceUrl, resourceInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(resourceUrl).toBe(RESOURCE_URL);
    expect(resourceInit.headers).toMatchObject({ Authorization: "Bearer unit-firma-key" });
    const [pdfUrl, pdfInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(pdfUrl).toBe(SIGNED_URL);
    expect((pdfInit.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it("prefers final_document_download_url when the resource carries it", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse({ final_document_download_url: FINAL_URL }))
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    await expect(adapter.fetchCompletedDocument("env_doc_1")).resolves.toEqual(EVIDENCE_BYTES);
    const [pdfUrl] = fetchMock.mock.calls[1] as unknown as [string];
    expect(pdfUrl).toBe(FINAL_URL);
  });

  it("falls back to document_url when the final URL yields no PDF bytes", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse({ final_document_download_url: FINAL_URL }));
      if (String(input) === FINAL_URL) return Promise.resolve(jsonResponse(404, { error: "not ready" }));
      return Promise.resolve(bytesResponse(200, EVIDENCE_BYTES));
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    await expect(adapter.fetchCompletedDocument("env_doc_1")).resolves.toEqual(EVIDENCE_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws on a non-200 resource response (route 500s → Firma retries, nothing persisted)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(503, { error: "unavailable" }))));
    const adapter = new FirmaAdapter();

    await expect(adapter.fetchCompletedDocument("env_doc_2")).rejects.toThrow(/completed-document resource fetch failed \(503\)/);
  });

  it("throws when the resource exposes no download URL (both absent or non-string)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(resourceResponse({ document_url: null, final_document_download_url: 42 }))));
    const adapter = new FirmaAdapter();

    await expect(adapter.fetchCompletedDocument("env_doc_3")).rejects.toThrow(/exposes no download URL/);
  });

  it("throws when no candidate URL yields PDF bytes (200 with EMPTY or non-PDF bytes must never become evidence)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(bytesResponse(200, new TextEncoder().encode('{"error":"not found"}'))),
    ));
    const adapter = new FirmaAdapter();

    await expect(adapter.fetchCompletedDocument("env_doc_4")).rejects.toThrow(/no candidate URL returned PDF bytes/);
  });
});

describe("FirmaAdapter.uploadConsentEvidence (F1 upload + read-back verify)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("PUTs the raw PDF bytes with service-role headers and verifies with a read-back GET", async () => {
    vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("SUPABASE_SECRET_KEY", SUPABASE_KEY);
    const fetchMock = vi.fn((input: unknown, init?: { method?: string }) =>
      init?.method === "PUT"
        ? Promise.resolve(jsonResponse(200, {}))
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    await expect(adapter.uploadConsentEvidence("user_9/env_f125.pdf", EVIDENCE_BYTES)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(putUrl).toBe(`${SUPABASE_URL}/storage/v1/object/consents/user_9/env_f125.pdf`);
    expect(putInit.method).toBe("PUT");
    expect(putInit.headers).toMatchObject({
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    });
    const uploadedBytes = new Uint8Array(putInit.body as Uint8Array);
    expect(uploadedBytes).toEqual(EVIDENCE_BYTES);
    const [verifyUrl] = fetchMock.mock.calls[1] as unknown as [string];
    expect(verifyUrl).toBe(`${SUPABASE_URL}/storage/v1/object/consents/user_9/env_f125.pdf`);
  });

  it("throws on a failed PUT and never runs the verification GET", async () => {
    vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("SUPABASE_SECRET_KEY", SUPABASE_KEY);
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(500, { error: "storage down" })));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    await expect(adapter.uploadConsentEvidence("user_9/env_f125.pdf", EVIDENCE_BYTES)).rejects.toThrow(
      /Consent evidence upload failed \(500\)/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // PUT only
  });

  it("throws when the read-back verification GET is not 200", async () => {
    vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("SUPABASE_SECRET_KEY", SUPABASE_KEY);
    const fetchMock = vi.fn((input: unknown, init?: { method?: string }) =>
      init?.method === "PUT"
        ? Promise.resolve(jsonResponse(200, {}))
        : Promise.resolve(jsonResponse(404, { error: "not found" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    await expect(adapter.uploadConsentEvidence("user_9/env_f125.pdf", EVIDENCE_BYTES)).rejects.toThrow(
      /Consent evidence verification failed \(404\)/,
    );
  });

  it("throws when the verification GET reads bytes that do not match the upload (empty included)", async () => {
    vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("SUPABASE_SECRET_KEY", SUPABASE_KEY);
    const fetchMock = vi.fn((input: unknown, init?: { method?: string }) =>
      init?.method === "PUT"
        ? Promise.resolve(jsonResponse(200, {}))
        : Promise.resolve(bytesResponse(200, new Uint8Array(0))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    await expect(adapter.uploadConsentEvidence("user_9/env_f125.pdf", EVIDENCE_BYTES)).rejects.toThrow(
      /verification mismatch/,
    );
  });

  it("fails loud when Supabase env is unconfigured (no silent skip)", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter();

    await expect(adapter.uploadConsentEvidence("user_9/env_f125.pdf", EVIDENCE_BYTES)).rejects.toThrow(
      /SUPABASE_URL\/SUPABASE_SECRET_KEY are not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
