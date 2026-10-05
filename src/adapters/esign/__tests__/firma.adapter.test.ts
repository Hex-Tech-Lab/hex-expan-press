// Fail-closed contract tests for the Firma adapter (Wave 5.1, qa-intel
// security rule: the HMAC gate here is authorization-relevant and needs a
// sibling regression test).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Agent as UndiciAgent } from "undici";
import { FirmaAdapter, pinnedDispatcherFactory, pinnedDownloadFetch, pinnedLookupFor, type PinnedDispatcherFactory, type Pin } from "../firma.adapter";
import { passthroughDownload } from "../../../../tests/helpers/esign-transport";

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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }), SECRET);
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
  });

  it("rejects a wrong-secret signature while the secret is configured", async () => {
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }), "attacker-secret");
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("accepts a validly-signed completed envelope and maps the event", async () => {
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
    const { body } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    const result = await adapter.parseAndValidateWebhook(body, { "content-type": "application/json" });
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("rejects a WRONG-LENGTH signature without throwing", async () => {
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    headers["x-firma-signature"] = "abcd";
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("rejects a NON-HEX signature without throwing", async () => {
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
    const { body, headers } = signedBody(completedPayload({ productId: "p1", userId: "u1" }));
    headers["x-firma-signature"] = "z".repeat(64);
    const result = await adapter.parseAndValidateWebhook(body, headers);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  // Buffer.from(hex) truncates at junk / an unmatched final digit — a valid
  // signature with a suffix must still be rejected (CodeRabbit, PR #24).
  it.each([["z"], ["a"]])("rejects a VALID signature followed by %j", async (suffix) => {
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);
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
    return jsonResponse(200, {
      id: "env_doc_1",
      // Live-verified shape: status is an OBJECT, not a string.
      status: { sent: true, finished: true, cancelled: false, declined: false, expired: false },
      // Sprint-12-C: final_document_download_url is REQUIRED (document_url is
      // the unsigned source document and is never fetched anymore).
      final_document_download_url: FINAL_URL,
      document_url: SIGNED_URL,
      ...overrides,
    });
  }

  it("two-step flow: GET resource JSON → GET signed URL bytes, no Bearer forwarded to the signed URL", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    const bytes = await adapter.fetchCompletedDocument("env_doc_1");

    expect(bytes).toEqual(EVIDENCE_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [resourceUrl, resourceInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(resourceUrl).toBe(RESOURCE_URL);
    expect(resourceInit.headers).toMatchObject({ Authorization: "Bearer unit-firma-key" });
    const [pdfUrl, pdfInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(pdfUrl).toBe(FINAL_URL);
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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_doc_1")).resolves.toEqual(EVIDENCE_BYTES);
    const [pdfUrl] = fetchMock.mock.calls[1] as unknown as [string];
    expect(pdfUrl).toBe(FINAL_URL);
  });

  it("TERMINAL (sprint-12-C): no document_url fallback — a failing final URL never degrades to the unsigned source document", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse({ final_document_download_url: FINAL_URL }));
      if (String(input) === FINAL_URL) return Promise.resolve(jsonResponse(404, { error: "not ready" }));
      return Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)); // document_url serves a VALID PDF — must never be fetched
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_doc_1")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls).not.toContain(SIGNED_URL); // the unsigned source document was never requested
    expect(fetchMock).toHaveBeenCalledTimes(2); // resource GET + the one strict candidate
  });

  it("TERMINAL (sprint-12-C): null final_document_download_url rejects even though document_url serves valid PDF bytes", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse({ final_document_download_url: null }));
      return Promise.resolve(bytesResponse(200, EVIDENCE_BYTES));
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_doc_1")).rejects.toThrow(/no final_document_download_url/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no download fetch at all
  });

  it("throws on a non-200 resource response (route 500s → Firma retries, nothing persisted)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse(503, { error: "unavailable" }))));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_doc_2")).rejects.toThrow(/completed-document resource fetch failed \(503\)/);
  });

  it("TERMINAL (sprint-12-C): non-string final_document_download_url rejects", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(resourceResponse({ document_url: null, final_document_download_url: 42 }))));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_doc_3")).rejects.toThrow(/no final_document_download_url/);
  });

  it("throws when no candidate URL yields PDF bytes (200 with EMPTY or non-PDF bytes must never become evidence)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(bytesResponse(200, new TextEncoder().encode('{"error":"not found"}'))),
    ));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_doc_4")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
  });

  // ---- Sprint-12-B: state finality (draft-acceptance vulnerability) ----

  it("TERMINAL: refuses a non-finished envelope (draft) — no download fetch at all", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse({ status: { sent: true, finished: false, cancelled: false, declined: false, expired: false } }))
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_draft")).rejects.toThrow(/not a FINISHED signature request.*finished.:false/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // resource GET only — never the signed URL
  });

  it("TERMINAL: refuses a cancelled envelope (even with document_url present)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse({ status: { sent: true, finished: false, cancelled: true, declined: false, expired: false } }))
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    ));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_cancelled")).rejects.toThrow(/not a FINISHED signature request/);
  });

  it("TERMINAL: refuses when is_partial===true (honored defensively per directive)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse({ is_partial: true }))
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    ));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_partial")).rejects.toThrow(/is_partial=true/);
  });

  // ---- Sprint-12-B: SSRF surface + credential hygiene ----

  it.each([
    ["http://storage.firma.test/object/sign/a.pdf?token=t", "plain http"],
    ["https://localhost/object/sign/a.pdf", "localhost"],
    ["https://169.254.169.254/latest/meta-data", "cloud metadata endpoint"],
    ["https://10.0.0.5/object/sign/a.pdf", "private 10.x"],
    ["https://[::1]/object/sign/a.pdf", "IPv6 loopback (bracketed literal)"],
    ["https://[::ffff:127.0.0.1]/object/sign/a.pdf", "IPv4-mapped loopback"],
    ["https://[::ffff:169.254.169.254]/latest/meta-data", "IPv4-mapped metadata endpoint"],
    ["https://[::ffff:8.8.8.8]/object/sign/a.pdf", "IPv4-mapped public (whole class rejected)"],
    ["https://[fe80::1]/object/sign/a.pdf", "IPv6 link-local"],
    ["https://[fd00::1]/object/sign/a.pdf", "IPv6 unique-local (fc00::/7)"],
    ["https://[::]/object/sign/a.pdf", "unspecified address"],
  ])("rejects unsafe download URL (%s — %s)", async (badUrl) => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse({ final_document_download_url: badUrl }))
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    ));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_ssrf")).rejects.toThrow(/failed the HTTPS\/SSRF validation/);
  });

  it("sends NO credentials to the signed URL: headers empty, credentials omitted", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    let signedUrlInit: RequestInit | undefined;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      if (!String(input).includes("/signing-requests/")) signedUrlInit = init;
      return String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES));
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await adapter.fetchCompletedDocument("env_doc_1");

    const headers = ((signedUrlInit?.headers ?? {}) as Record<string, unknown>);
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["apikey"]).toBeUndefined();
    expect(Object.keys(headers)).toHaveLength(0);
    expect(signedUrlInit?.credentials).toBe("omit");
  });

  it("loop containment: a network rejection during download is caught INSIDE the loop (aggregate error, not the raw throw)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse());
      return Promise.reject(new TypeError("fetch failed: DNS timeout")); // network-level rejection
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    // The raw TypeError must NOT escape — the loop catches, logs, and the
    // aggregate terminal error is thrown instead.
    await expect(adapter.fetchCompletedDocument("env_neterr")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
    await expect(adapter.fetchCompletedDocument("env_neterr2").catch((e: unknown) => Promise.reject((e as Error).message.includes("DNS timeout") ? new Error("RAW-ESCAPED") : e))).rejects.toThrow(/did not yield PDF bytes/);
  });

  it("a redirecting signed URL is NOT followed (redirect: manual — founder-applied hardening)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const redirectTarget = "https://internal.service/steal";
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse());
      // 302 → with redirect:"manual" the response is returned UNFOLLOWED;
      // res.ok is false → the candidate is rejected, nothing is fetched at the target.
      return Promise.resolve(new Response(null, { status: 302, headers: { location: redirectTarget } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_redirect")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls).not.toContain(redirectTarget); // the redirect was never followed
  });

  // ---- Sprint-12 closure: DNS-level SSRF defense (Cubic P2 on PR #82) ----

  it("rejects a benign hostname that RESOLVES into a private range (DNS rebinding/metadata)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    // The provider-controlled name resolves at 169.254.169.254 — must be rejected BEFORE any byte fetch.
    const adapter = new FirmaAdapter(async () => [{ address: "169.254.169.254" }], passthroughDownload);
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse());
      return Promise.resolve(bytesResponse(200, EVIDENCE_BYTES));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(adapter.fetchCompletedDocument("env_dns")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // resource GET only — the signed URL was never fetched
  });

  it("fails CLOSED when host resolution throws (no fetch without a verified address)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse());
      return Promise.resolve(bytesResponse(200, EVIDENCE_BYTES));
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => { throw new Error("ENOTFOUND (simulated resolver outage)"); }, passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_dnsfail")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // resource GET only — the signed URL was never fetched
  });

  it("accepts when every resolved address is public (multi-A record)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const fetchMock = vi.fn((input: unknown) => {
      if (String(input).includes("/signing-requests/")) return Promise.resolve(resourceResponse());
      return Promise.resolve(bytesResponse(200, EVIDENCE_BYTES));
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }, { address: "2606:2800:220:1:248:1893:25c8:1946" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_multi")).resolves.toEqual(EVIDENCE_BYTES);
  });

  // ---- Sprint-12-B: memory exhaustion cap ----

  it("rejects when content-length exceeds the 20 MiB cap (cancelled before buffering)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const cancel = vi.fn(async () => {});
    const oversized = new Response(null, { headers: { "content-length": String(21 * 1024 * 1024) } });
    Object.defineProperty(oversized, "body", { value: { cancel } });
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(oversized),
    ));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_big")).rejects.toThrow(/20 MiB cap/);
    expect(cancel).toHaveBeenCalled();
  });

  it("aborts mid-stream when streamed chunks exceed the 20 MiB cap (reader.cancel called)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const cancel = vi.fn(async () => {});
    const bigChunk = new Uint8Array(11 * 1024 * 1024); // two chunks → 22 MiB > cap
    let reads = 0;
    const fakeRes = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => (reads++ < 2 ? { done: false, value: bigChunk } : { done: true, value: undefined }),
          cancel,
        }),
      },
    };
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(fakeRes),
    ));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.fetchCompletedDocument("env_stream")).rejects.toThrow(/20 MiB cap/);
    expect(cancel).toHaveBeenCalled(); // the stall/overflow was cut off immediately
  });

  it("streams a large-but-legal payload (just under the cap) end to end", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const chunk = new Uint8Array(10 * 1024 * 1024); // 2 × 10 MiB = 20 MiB exactly (not > cap)
    chunk[0] = 0x25; chunk[1] = 0x50; chunk[2] = 0x44; chunk[3] = 0x46; chunk[4] = 0x2d; // "%PDF-"
    let reads = 0;
    const fakeRes = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => (reads++ < 2 ? { done: false, value: chunk } : { done: true, value: undefined }),
          cancel: vi.fn(async () => {}),
        }),
      },
    };
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(resourceResponse())
        : Promise.resolve(fakeRes),
    ));
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    const bytes = await adapter.fetchCompletedDocument("env_edge");
    expect(bytes.byteLength).toBe(20 * 1024 * 1024);
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-"); // header preserved through the stream
  });
});

// ---------------------------------------------------------------------------
// Sprint 13 (P0): DNS-pinned dispatcher — TOCTOU eradication. The sprint-12
// DNS-level defense validated resolved addresses BEFORE the fetch, but the
// fetch then resolved the hostname a SECOND time on its own — a 0-TTL DNS
// rebinding in that millisecond window could rebind the dial target onto an
// internal/metadata IP. The pinned dispatcher closes the window
// structurally: the transport NEVER consults DNS; it dials exactly the
// validated address set. These tests run against REAL local sockets.
// ---------------------------------------------------------------------------
describe("Sprint-13: DNS-pinned dispatcher (TOCTOU eradication)", () => {
  it("PRODUCTION transport dials the pinned address with the original Host header — no DNS lookup can occur (NXDOMAIN-proof host)", async () => {
    const seen: { host?: string; remote?: string }[] = [];
    const server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, remote: req.socket.remoteAddress });
      res.writeHead(200, { "content-type": "application/pdf", "content-length": String(EVIDENCE_BYTES.byteLength) });
      res.end(Buffer.from(EVIDENCE_BYTES));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // `pin-e2e.invalid` is in the reserved .invalid TLD: REAL DNS would
      // answer NXDOMAIN. Success here therefore PROVES the dial went to the
      // pinned 127.0.0.1 without any resolution of the URL hostname.
      const pin: Pin = { host: "pin-e2e.invalid", addresses: ["127.0.0.1"] };
      const res = await pinnedDownloadFetch(
        `http://pin-e2e.invalid:${port}/final.pdf`,
        { redirect: "manual" },
        pinnedDispatcherFactory(pin),
      );
      expect(res.status).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(Buffer.from(body.slice(0, 5)).toString("latin1")).toBe("%PDF-");
      expect(seen).toHaveLength(1);
      expect(seen[0].host).toBe(`pin-e2e.invalid:${port}`); // Host header keeps the hostname
      expect(seen[0].remote).toBe("127.0.0.1"); // the dial target is the PINNED address
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("TLS dial preserves the hostname as SNI while physically dialing the pinned IP", async () => {
    const seen: { host?: string; sni?: string; remote?: string }[] = [];
    // Hermetic fixture: self-signed cert generated at runtime into tmpdir —
    // never committed, never leaves the machine.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "firma-pin-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-nodes", "-subj", "/CN=pin-e2e.invalid",
      "-addext", "subjectAltName=DNS:pin-e2e.invalid",
    ]);
    const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
      const socket = req.socket as tls.TLSSocket;
      seen.push({ host: req.headers.host, sni: typeof socket.servername === "string" ? socket.servername : undefined, remote: socket.remoteAddress });
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from(EVIDENCE_BYTES));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const pin: Pin = { host: "pin-e2e.invalid", addresses: ["127.0.0.1"] };
      // Test-only TLS relaxation: the PRODUCTION factory enforces cert
      // verification; this fixture only relaxes trust for the self-signed
      // local cert. The pin lookup itself IS production code.
      const testFactory: PinnedDispatcherFactory = (p) =>
        new UndiciAgent({ connect: { rejectUnauthorized: false, lookup: pinnedLookupFor(p) as never } }) as unknown as ReturnType<PinnedDispatcherFactory>;
      const res = await pinnedDownloadFetch(
        `https://pin-e2e.invalid:${port}/final.pdf`,
        { redirect: "manual" },
        testFactory(pin),
      );
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0].sni).toBe("pin-e2e.invalid"); // TLS SNI = original hostname
      expect(seen[0].host).toBe(`pin-e2e.invalid:${port}`); // Host header = original hostname
      expect(seen[0].remote).toBe("127.0.0.1"); // dial target = pinned IP
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pinned lookup FAILS CLOSED for any hostname outside the validated pin", async () => {
    const lookup = pinnedLookupFor({ host: "storage.firma.test", addresses: ["93.184.216.34"] });
    const result = await new Promise<{ err: Error | null; addrs: unknown }>((resolve) => {
      lookup("evil.attacker.test", {}, (err, addrs) => resolve({ err, addrs }));
    });
    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toContain("SSRF pin violation");
    expect(result.addrs).toBeUndefined();
  });

  it("adapter feeds the VALIDATED pin into the dispatcher factory (and never when the host is rejected)", async () => {
    vi.stubEnv("FIRMA_API_KEY", "unit-firma-key");
    const finishedResource = (): Response =>
      new Response(JSON.stringify({
        id: "env_pin",
        status: { sent: true, finished: true, cancelled: false, declined: false, expired: false },
        final_document_download_url: "https://storage.firma.test/object/sign/consents/final.pdf?token=jwt",
      }), { status: 200 });
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(finishedResource())
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    ));
    const pins: Pin[] = [];
    const spyFactory: PinnedDispatcherFactory = (pin) => {
      pins.push(pin);
      return pinnedDispatcherFactory(pin);
    };
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload, spyFactory);
    await adapter.fetchCompletedDocument("env_pin_passed");
    expect(pins).toEqual([{ host: "storage.firma.test", addresses: ["93.184.216.34"] }]);

    // Negative: a host resolving into a forbidden range never reaches the
    // transport — the factory must NOT be invoked (no dispatcher, no dial).
    pins.length = 0;
    const rebindingAdapter = new FirmaAdapter(async () => [{ address: "169.254.169.254" }], passthroughDownload, spyFactory);
    vi.stubGlobal("fetch", vi.fn((input: unknown) =>
      String(input).includes("/signing-requests/")
        ? Promise.resolve(finishedResource())
        : Promise.resolve(bytesResponse(200, EVIDENCE_BYTES)),
    ));
    await expect(rebindingAdapter.fetchCompletedDocument("env_pin_blocked")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
    expect(pins).toEqual([]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("multi-A pin: EVERY validated address is dialable; the dispatcher answers with the full set", async () => {
    const lookup = pinnedLookupFor({ host: "storage.firma.test", addresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
    const v4 = await new Promise<{ err: Error | null; addrs?: { address: string; family: number }[] }>((resolve) =>
      lookup("storage.firma.test", {}, (err, addrs) => resolve({ err, addrs })));
    expect(v4.err).toBeNull();
    expect(v4.addrs).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

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
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.uploadConsentEvidence("user_9/env_f125.pdf", EVIDENCE_BYTES)).rejects.toThrow(
      /verification mismatch/,
    );
  });

  it("fails loud when Supabase env is unconfigured (no silent skip)", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload);

    await expect(adapter.uploadConsentEvidence("user_9/env_f125.pdf", EVIDENCE_BYTES)).rejects.toThrow(
      /SUPABASE_URL\/SUPABASE_SECRET_KEY are not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
