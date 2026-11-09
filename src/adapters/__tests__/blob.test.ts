import { describe, it, expect } from "vitest";

function makeMockBlobToken(bucketId: string, pw: string, hash: string): string {
  const enc = new TextEncoder();
  const idBytes = enc.encode(bucketId);
  const pwBytes = enc.encode(pw);
  const hBytes = enc.encode(hash);

  const out = new Uint8Array(6 + idBytes.length + pwBytes.length + hBytes.length);
  out[0] = 0x02; // TOKEN_VERSION
  out[1] = 0;    // flags
  out[2] = idBytes.length;
  out[3] = (pwBytes.length >> 8) & 0xff;
  out[4] = pwBytes.length & 0xff;
  out[5] = hBytes.length;
  out.set(idBytes, 6);
  out.set(pwBytes, 6 + idBytes.length);
  out.set(hBytes, 6 + idBytes.length + pwBytes.length);

  let bin = "";
  for (const b of out) bin += String.fromCharCode(b);
  return Buffer.from(bin, "binary").toString("base64url");
}

describe("Upstash Blob Client Module", () => {
  it("exports Bucket and blob functions without throwing on import", async () => {
    delete process.env.UPSTASH_BLOB_TOKEN;
    const { blob, getBlobBucket, uploadMedia, getMediaReadUrl, deleteMedia } = await import("../../../lib/blob.ts");

    expect(blob).toBeDefined();
    expect(typeof getBlobBucket).toBe("function");
    expect(typeof uploadMedia).toBe("function");
    expect(typeof getMediaReadUrl).toBe("function");
    expect(typeof deleteMedia).toBe("function");
  });

  it("initializes Bucket when a valid Upstash token format is provided", async () => {
    process.env.UPSTASH_BLOB_TOKEN = makeMockBlobToken("mock_b_id", "mock_pass", "mock_hash");

    const { getBlobBucket } = await import("../../../lib/blob.ts");
    const bucket = getBlobBucket();
    expect(bucket).toBeDefined();
    expect(typeof bucket.put).toBe("function");
    expect(typeof bucket.get).toBe("function");
    expect(typeof bucket.signedReadUrl).toBe("function");
  });

  it("forwards Web ReadableStream, size, and maxSize to Bucket.put", async () => {
    const { getBlobBucket, uploadMedia } = await import("../../../lib/blob.ts");
    const bucket = getBlobBucket();

    interface PutCapture {
      path: string;
      data: unknown;
      opts: { size?: number; maxSize?: number; multipart?: string; contentType?: string };
    }
    let putArgs: PutCapture | null = null;
    (bucket as unknown as { put: (path: string, data: unknown, opts: PutCapture["opts"]) => Promise<{ path: string; size?: number }> }).put = async (path, data, opts) => {
      putArgs = { path, data, opts };
      return { path, size: opts.size };
    };

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const res = await uploadMedia("streams/test.mp4", stream, {
      contentType: "video/mp4",
      size: bytes.byteLength,
      maxSize: 1000,
    });

    expect(putArgs).not.toBeNull();
    expect(putArgs!.path).toBe("streams/test.mp4");
    expect(putArgs!.data).toBe(stream);
    expect(putArgs!.opts.size).toBe(5);
    expect(putArgs!.opts.maxSize).toBe(1000);
    expect(putArgs!.opts.multipart).toBe("16mb");
    expect(putArgs!.opts.contentType).toBe("video/mp4");
    expect(res).toEqual({ path: "streams/test.mp4", size: 5 });
  });
});
