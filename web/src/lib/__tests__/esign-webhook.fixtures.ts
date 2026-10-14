// Shared fixtures for the esign webhook contract tests (split from esign-webhook.test.ts).
import crypto from "node:crypto";
import { vi, type Mock } from "vitest";

// nosemgrep: codacy.javascript.security.hard-coded-password -- dummy HMAC key for tests
export const SECRET = "test-webhook-secret";
export const AGREEMENT_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"
// The webhook's document_sha256 is Firma's attestation of the SIGNED document;
// the evidence flow hashes the fetched bytes and cross-checks (sprint 12), so
// the fixture hash MUST equal the hash of the bytes the fetch mock returns.
export const DOCUMENT_HASH = crypto.createHash("sha256").update(AGREEMENT_PDF_BYTES).digest("hex");

export function signedBody(payload: unknown, secret = SECRET): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return { body, headers: { "x-firma-signature": signature, "content-type": "application/json" } };
}

export function completedPayload(metadata: Record<string, string>, envelopeId = "env_123"): unknown {
  return {
    type: "signing_request.completed",
    data: {
      signing_request: {
        id: envelopeId,
        document_sha256: DOCUMENT_HASH,
        metadata,
      },
    },
  };
}

/** Hermetic fetch stub for the evidence flow (sprint-12 live shape):
 *  GET the signing-request RESOURCE → JSON {document_url: signed URL};
 *  GET the signed URL → PDF bytes; Storage PUT + read-back verification GET.
 *  Any other call fails the test. */
export function evidenceFetchMock(): Mock {
  return vi.fn((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/signing-requests\/[^/]+$/.test(url)) {
      // Live-verified 2026-10-05: the resource carries a freshly-minted signed
      // Storage URL (final_document_download_url null on unfinished requests).
      // Sprint-12-B: the state-finality guard requires status.finished === true.
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          id: "env",
          status: { sent: true, finished: true, cancelled: false, declined: false, expired: false },
          // Sprint-12-C: final_document_download_url is REQUIRED.
          final_document_download_url: "https://firma-storage.test/object/sign/agreement-final.pdf?token=t",
          document_url: "https://firma-storage.test/object/sign/agreement.pdf?token=t",
        }),
        arrayBuffer: () => Promise.reject(new Error("resource must not be read as bytes")),
      });
    }
    if (method === "GET" && url.includes("/object/sign/")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(AGREEMENT_PDF_BYTES.slice().buffer) });
    }
    if (method === "PUT" && url.includes("/storage/v1/object/consents/")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    }
    if (method === "GET" && url.includes("/storage/v1/object/consents/")) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(AGREEMENT_PDF_BYTES.slice().buffer) });
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  });
}
