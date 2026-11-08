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
});
