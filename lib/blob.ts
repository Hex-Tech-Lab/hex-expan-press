import { Bucket } from "@upstash/blob";

let _bucketInstance: Bucket | null = null;

/**
 * Returns the lazily-initialized Upstash Blob Bucket instance.
 * Reads UPSTASH_BLOB_TOKEN from process.env or .env.local on first access.
 */
export function getBlobBucket(): Bucket {
  if (!_bucketInstance) {
    _bucketInstance = Bucket.fromEnv();
  }
  return _bucketInstance;
}

/**
 * Resilient proxy to the Upstash Blob Bucket.
 * Defers token reading until an actual method is called.
 */
export const blob: Bucket = new Proxy({} as Bucket, {
  get(_target, prop) {
    const bucket = getBlobBucket();
    const val = (bucket as any)[prop];
    return typeof val === "function" ? val.bind(bucket) : val;
  },
});

export { Bucket };

/**
 * Upload a media file or stream directly to the Upstash Blob bucket.
 * Supports decimal-chunked multipart upload for large (>16MB) video and audio files.
 */
export async function uploadMedia(
  filePath: string,
  data: Request | Blob | ArrayBuffer | Uint8Array | string | ReadableStream,
  options: {
    contentType?: string;
    size?: number;
    maxSize?: number;
    allowOverwrite?: boolean;
    metadata?: Record<string, string>;
  } = {}
) {
  const b = getBlobBucket();
  return await b.put(filePath, data as any, {
    contentType: options.contentType || "application/octet-stream",
    allowOverwrite: options.allowOverwrite ?? true,
    multipart: "16mb",
    size: options.size,
    maxSize: options.maxSize,
    metadata: options.metadata,
  });
}

/**
 * Generate a signed read URL with byte-range streaming support for media playback.
 */
export async function getMediaReadUrl(
  filePath: string,
  options: { expiresIn?: string; downloadAs?: string } = {}
) {
  const b = getBlobBucket();
  return await b.signedReadUrl(filePath, {
    expiresIn: (options.expiresIn || "24h") as any,
    downloadAs: options.downloadAs,
  });
}

/**
 * Delete a media file or prefix from the bucket.
 */
export async function deleteMedia(filePathOrPrefix: string) {
  const b = getBlobBucket();
  if (filePathOrPrefix.endsWith("/")) {
    return await b.del({ prefix: filePathOrPrefix });
  }
  return await b.del(filePathOrPrefix);
}
