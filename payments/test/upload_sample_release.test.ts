import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry.ts";
import { uploadSampleRelease } from "../../scripts/upload_sample_release.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function writeFixtureBookAndPdf(opts: { pdfBytes?: Uint8Array; overrideSha256?: string; overrideBytes?: number } = {}) {
  const dir = mkdtempSync(joinSafe(tmpdir(), "upload-sample-release-"));
  tmpDirs.push(dir);
  const pdfBytes = opts.pdfBytes ?? new TextEncoder().encode("%PDF-1.7\nSample Quiet Workshop Fixture\n");
  const pdfPath = joinSafe(dir, "sample.pdf");
  writeFileSync(pdfPath, pdfBytes);
  const actualSha = createHash("sha256").update(pdfBytes).digest("hex");

  const bookJsonPath = joinSafe(dir, "book.json");
  writeFileSync(
    bookJsonPath,
    JSON.stringify({
      id: "sample_the_quiet_workshop",
      title: "The Quiet Workshop (Sample)",
      subtitle: "Twelve Practical Projects for a Small Home Bench",
      author: "Elias Hartwell",
      data_dir: "data/books/house_expanpress/the_quiet_workshop",
      release_pdf: "sample.pdf",
      release_path: "release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf",
      release_sha256: opts.overrideSha256 ?? actualSha,
      release_bytes: opts.overrideBytes ?? pdfBytes.byteLength,
    }),
  );
  return { dir, pdfPath, pdfBytes, actualSha, bookJsonPath };
}

function joinSafe(base: string, child: string): string {
  return path.join(base, child);
}

describe("upload_sample_release", () => {
  it("supports --dry-run, verifies local sha256 + bytes, and performs zero network calls", async () => {
    const { pdfPath, pdfBytes, actualSha, bookJsonPath } = writeFixtureBookAndPdf();
    const fetchSpy = vi.fn();

    const result = await uploadSampleRelease({
      bookFile: bookJsonPath,
      fileOverride: pdfPath,
      dryRun: true,
      env: {},
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      dryRun: true,
      bucket: GLOBAL.delivery.bucket,
      objectKey: "release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf",
      localFile: pdfPath,
      bytes: pdfBytes.byteLength,
      localSha256: actualSha,
      expectedSha256: actualSha,
      verifiedBefore: true,
      uploaded: false,
      alreadyExists: false,
      verifiedAfter: false,
      remoteSha256: null,
      remoteBytes: null,
      uploadStatus: null,
      verifyStatus: null,
    });
  });

  it("refuses before any upload when local sha256 differs from the registry hash", async () => {
    const { pdfPath, bookJsonPath } = writeFixtureBookAndPdf({
      overrideSha256: "a".repeat(64),
    });
    const fetchSpy = vi.fn();

    await expect(
      uploadSampleRelease({
        bookFile: bookJsonPath,
        fileOverride: pdfPath,
        dryRun: false,
        env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "test-key" },
        fetchImpl: fetchSpy as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/local sha256 .* differs from expected/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses before any upload when local byte length differs from the registry size", async () => {
    const { pdfPath, bookJsonPath } = writeFixtureBookAndPdf({
      overrideBytes: 999999,
    });
    const fetchSpy = vi.fn();

    await expect(
      uploadSampleRelease({
        bookFile: bookJsonPath,
        fileOverride: pdfPath,
        dryRun: true,
        env: {},
        fetchImpl: fetchSpy as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/local byte length .* differs from expected/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads to GLOBAL.delivery.bucket and verifies sha256 on GET readback", async () => {
    const { pdfPath, pdfBytes, actualSha, bookJsonPath } = writeFixtureBookAndPdf();
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string> });
      if (method === "POST") {
        return new Response(JSON.stringify({ Key: "release-files/release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf" }), {
          status: 200,
        });
      }
      return new Response(Buffer.from(pdfBytes), { status: 200 });
    });

    const result = await uploadSampleRelease({
      bookFile: bookJsonPath,
      fileOverride: pdfPath,
      dryRun: false,
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "test-key" },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      `https://example.supabase.co/storage/v1/object/${GLOBAL.delivery.bucket}/release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf`,
    );
    expect(calls[0].headers["x-upsert"]).toBe("false");
    expect(calls[1].method).toBe("GET");
    expect(result).toMatchObject({
      dryRun: false,
      bucket: GLOBAL.delivery.bucket,
      verifiedBefore: true,
      uploaded: true,
      alreadyExists: false,
      verifiedAfter: true,
      remoteSha256: actualSha,
      remoteBytes: pdfBytes.byteLength,
      uploadStatus: "200 OK",
      verifyStatus: "200 OK",
    });
  });

  it("refuses loudly when post-upload GET readback hash differs", async () => {
    const { pdfPath, pdfBytes, bookJsonPath } = writeFixtureBookAndPdf();
    const tampered = Buffer.from(pdfBytes);
    tampered[0] = tampered[0] ^ 0xff;

    const mockFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response("{}", { status: 200 });
      }
      return new Response(tampered, { status: 200 });
    });

    await expect(
      uploadSampleRelease({
        bookFile: bookJsonPath,
        fileOverride: pdfPath,
        dryRun: false,
        env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "test-key" },
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/post-upload sha256 mismatch/);
  });

  it("verifies existing remote bytes on 409 Conflict without overwriting and refuses if remote hash differs", async () => {
    const { pdfPath, pdfBytes, actualSha, bookJsonPath } = writeFixtureBookAndPdf();

    const matchingFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Response('{"error":"Duplicate"}', { status: 409 });
      return new Response(Buffer.from(pdfBytes), { status: 200 });
    });

    const okResult = await uploadSampleRelease({
      bookFile: bookJsonPath,
      fileOverride: pdfPath,
      dryRun: false,
      env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "test-key" },
      fetchImpl: matchingFetch as unknown as typeof fetch,
    });
    expect(okResult).toMatchObject({
      uploaded: false,
      alreadyExists: true,
      verifiedAfter: true,
      remoteSha256: actualSha,
      uploadStatus: "409 Conflict",
      verifyStatus: "200 OK",
    });

    const mismatchedFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Response('{"error":"Duplicate"}', { status: 409 });
      return new Response(Buffer.alloc(pdfBytes.byteLength, 0x41), { status: 200 });
    });

    await expect(
      uploadSampleRelease({
        bookFile: bookJsonPath,
        fileOverride: pdfPath,
        dryRun: false,
        env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "test-key" },
        fetchImpl: mismatchedFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/post-upload sha256 mismatch/);
  });
});
