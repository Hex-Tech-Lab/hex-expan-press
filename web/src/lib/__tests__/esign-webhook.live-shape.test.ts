// Firma fetchCompletedDocument live-shape contract (split from esign-webhook.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FirmaAdapter } from "../../../../src/adapters/esign/firma.adapter";
import { passthroughDownload } from "../../../../tests/helpers/esign-transport";
import { AGREEMENT_PDF_BYTES } from "./esign-webhook.fixtures";

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

// Sprint 12 Task 1: fetchCompletedDocument LIVE-SHAPE contract (verified
// against the production Firma API 2026-10-05 — probe transcript in
// docs/agent-prompts/sprint12-firma-live-shape.md):
//   GET {base}/signing-requests/{id}            → 200 JSON resource carrying
//     `document_url` (freshly-minted signed Storage URL, ~1h TTL) and
//     `final_document_download_url` (finished-document slot, null when
//     unfinished). Both `/documents` and `/documents/download` are 404.
describe("FirmaAdapter.fetchCompletedDocument — live-shape contract", () => {
  beforeEach(() => {
    vi.stubEnv("FIRMA_API_BASE", "https://api.firma.test/functions/v1/signing-request-api");
    vi.stubEnv("FIRMA_API_KEY", "unit-test-firma-key");
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("two-step flow: resource JSON → signed URL bytes (%PDF- gate)", async () => {
    const fetchMock = vi.fn((input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (/\/signing-requests\/[^/]+$/.test(url)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: { sent: true, finished: true, cancelled: false, declined: false, expired: false }, final_document_download_url: "https://firma-storage.test/object/sign/a-final.pdf?token=t", document_url: "https://firma-storage.test/object/sign/a.pdf?token=t" }) });
      }
      if (url.includes("/object/sign/")) {
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(AGREEMENT_PDF_BYTES.slice().buffer) });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { FirmaAdapter } = await import("../../../../src/adapters/esign/firma.adapter");
    const bytes = await new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload).fetchCompletedDocument("env_x");
    expect(Buffer.from(bytes).toString("latin1")).toBe("%PDF-1");
    // The signed URL must be fetched WITHOUT our credentials (self-authorizing token).
    expect((fetchMock.mock.calls[1][1] as RequestInit | undefined)?.headers).toBeUndefined();
  });

  it("prefers final_document_download_url when populated, falls back to document_url", async () => {
    const fetchMock = vi.fn((input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (/\/signing-requests\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            status: { sent: true, finished: true, cancelled: false, declined: false, expired: false },
            final_document_download_url: "https://firma-storage.test/object/sign/final.pdf?token=t",
            document_url: "https://firma-storage.test/object/sign/original.pdf?token=t",
          }),
        });
      }
      if (url.includes("final.pdf")) {
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(AGREEMENT_PDF_BYTES.slice().buffer) });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { FirmaAdapter } = await import("../../../../src/adapters/esign/firma.adapter");
    await new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload).fetchCompletedDocument("env_y");
    expect(String(fetchMock.mock.calls[1][0])).toContain("final.pdf");
  });

  it("TERMINAL (sprint-12-C): a failing final URL never degrades to the unsigned document_url", async () => {
    const fetchMock = vi.fn((input: unknown) => {
      const url = String(input);
      if (/\/signing-requests\/[^/]+$/.test(url)) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            status: { sent: true, finished: true, cancelled: false, declined: false, expired: false },
            final_document_download_url: "https://firma-storage.test/object/sign/final.pdf?token=t",
            document_url: "https://firma-storage.test/object/sign/original.pdf?token=t",
          }),
        });
      }
      if (url.includes("final.pdf")) {
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"error":"not ready"}').buffer) });
      }
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(AGREEMENT_PDF_BYTES.slice().buffer) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { FirmaAdapter } = await import("../../../../src/adapters/esign/firma.adapter");
    await expect(new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload).fetchCompletedDocument("env_z")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls.some((u) => u.includes("original.pdf"))).toBe(false); // unsigned source never fetched
  });

  it("fails LOUD when the resource GET 404s (old documents-endpoint shape is gone)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404 })));
    const { FirmaAdapter } = await import("../../../../src/adapters/esign/firma.adapter");
    await expect(new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload).fetchCompletedDocument("env_missing")).rejects.toThrow(/resource fetch failed \(404\)/);
  });

  it("fails LOUD when the resource exposes no valid HTTPS download URL", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: "env_q", status: { sent: true, finished: true, cancelled: false, declined: false, expired: false }, document_url: "https://firma-storage.test/object/sign/a.pdf?token=t" }) })));
    const { FirmaAdapter } = await import("../../../../src/adapters/esign/firma.adapter");
    await expect(new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload).fetchCompletedDocument("env_q")).rejects.toThrow(/no final_document_download_url/);
  });

  it("fails LOUD when the final URL fails the %PDF- gate (aggregate error)", async () => {
    vi.stubGlobal("fetch", vi.fn((input: unknown) => {
      const url = String(input);
      if (/\/signing-requests\/[^/]+$/.test(url)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: { sent: true, finished: true, cancelled: false, declined: false, expired: false }, final_document_download_url: "https://firma-storage.test/object/sign/a-final.pdf?token=t", document_url: "https://firma-storage.test/object/sign/a.pdf?token=t" }) });
      }
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new TextEncoder().encode("<html>nope</html>").buffer) });
    }));
    const { FirmaAdapter } = await import("../../../../src/adapters/esign/firma.adapter");
    await expect(new FirmaAdapter(async () => [{ address: "93.184.216.34" }], passthroughDownload).fetchCompletedDocument("env_junk")).rejects.toThrow(/did not yield PDF bytes within the 20 MiB cap/);
  });
});
