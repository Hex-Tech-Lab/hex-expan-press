import { describe, it, expect, vi, afterEach } from "vitest";
import { buildCanonicalRequest, putR2ObjectIf, statR2Object } from "../r2.adapter";

const endpoint = "https://acc.r2.cloudflarestorage.com";
const creds = { accessKeyId: "ak", secretAccessKey: "sk" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("statR2Object", () => {
  it("returns R2's ETag and the stored source ETag on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { etag: '"r2-1"', "x-amz-meta-supabase-etag": '"src-1"' } }),
    );

    const stat = await statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(stat).toEqual({ exists: true, etag: '"r2-1"', sourceEtag: '"src-1"' });
  });

  it("reports no source ETag for an object written before the freshness contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"r2-1"' } }));

    const stat = await statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(stat.exists).toBe(true);
    expect(stat.sourceEtag).toBeUndefined();
  });

  it("reports exists:false only on a confirmed 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    expect(await statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ exists: false });
  });

  it("throws on a server error instead of reporting absence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(
      statR2Object({ endpoint, bucket: "b", key: "k", ...creds, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow("HEAD object returned status 500");
  });
});

describe("putR2ObjectIf", () => {
  it("sends If-None-Match and the source ETag as signed headers, and reports written on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await putR2ObjectIf({
      endpoint,
      bucket: "b",
      key: "k",
      ...creds,
      body: "payload",
      ifNoneMatch: "*",
      metadata: { "supabase-etag": '"src-1"' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "written" });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      "if-none-match": "*",
      "x-amz-meta-supabase-etag": '"src-1"',
    });
    expect(decodeURIComponent(String(fetchImpl.mock.calls[0][0]))).toContain(
      "X-Amz-SignedHeaders=host;if-none-match;x-amz-meta-supabase-etag",
    );
  });

  it("maps 412 to precondition_failed, not to a generic failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 412 }));

    const result = await putR2ObjectIf({
      endpoint, bucket: "b", key: "k", ...creds, body: "x", ifMatch: '"r2-old"', fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "precondition_failed" });
  });

  it("maps other statuses to failed with the status in the reason", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    const result = await putR2ObjectIf({
      endpoint, bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "failed", reason: "PUT object returned status 500" });
  });

  it("maps a network error to failed, with the message", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hang up"));

    const result = await putR2ObjectIf({
      endpoint, bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ status: "failed", reason: "socket hang up" });
  });

  it("rejects an insecure http endpoint before sending any request", async () => {
    vi.stubEnv("R2_ALLOW_INSECURE_HTTP", "");
    const fetchImpl = vi.fn();

    await expect(
      putR2ObjectIf({
        endpoint: "http://acc.example.test", bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Insecure HTTP endpoint rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns failed for a malformed endpoint instead of throwing, and sends no request", async () => {
    vi.stubEnv("R2_ALLOW_INSECURE_HTTP", "");
    const fetchImpl = vi.fn();

    const result = await putR2ObjectIf({
      endpoint: "not a url", bucket: "b", key: "k", ...creds, body: "x", fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildCanonicalRequest with signed extra headers", () => {
  it("signs the extra headers in sorted order after host, lowercased", () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest(
      "PUT",
      "/b/k",
      "q=1",
      "acc.r2.cloudflarestorage.com",
      { "If-Match": '"e"', "x-amz-meta-supabase-etag": '"s"' },
    );

    expect(signedHeaders).toBe("host;if-match;x-amz-meta-supabase-etag");
    expect(canonicalRequest).toContain(
      'host:acc.r2.cloudflarestorage.com\nif-match:"e"\nx-amz-meta-supabase-etag:"s"\n\nhost;if-match;x-amz-meta-supabase-etag\n',
    );
  });
});
