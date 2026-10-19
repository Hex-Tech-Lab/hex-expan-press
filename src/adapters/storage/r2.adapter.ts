import { createHash, createHmac } from "node:crypto";
import type { StoragePort } from "../../domain/storage/storage.port";
import { GLOBAL } from "../../../payments/src/settings_registry";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
  region?: string;
  publicDomain?: string;
}

function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export interface GeneratePresignedUrlOptions {
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  expiresInSeconds?: number;
  date?: Date;
  publicDomain?: string;
}

/**
 * Generates an AWS SigV4 Presigned GET URL for Cloudflare R2 / S3-compatible storage.
 * Runs in pure Node.js (node:crypto) with 0 third-party dependencies, adhering strictly to
 * the frozen stack protocol.
 */
export function generateR2PresignedUrl(options: GeneratePresignedUrlOptions): string {
  const {
    endpoint,
    bucket,
    key,
    accessKeyId,
    secretAccessKey,
    region = "auto",
    expiresInSeconds = 300,
    date = new Date(),
    publicDomain,
  } = options;

  const url = new URL(endpoint);
  const host = publicDomain || url.host;

  // Clean key and build canonical URI (RFC 3986 encoded segments)
  const cleanKey = key.replace(/^\/+/, "");
  const bucketSegment = rfc3986(bucket);
  const keySegments = cleanKey.split("/").map(rfc3986).join("/");
  const canonicalUri = `/${bucketSegment}/${keySegments}`;

  // Timestamps
  const pad = (n: number) => n.toString().padStart(2, "0");
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  const amzDate = `${y}${m}${d}T${hh}${mm}${ss}Z`;
  const dateStamp = `${y}${m}${d}`;

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": expiresInSeconds.toString(),
    "X-Amz-SignedHeaders": "host",
  };

  const sortedParamKeys = Object.keys(queryParams).sort();
  const canonicalQueryString = sortedParamKeys
    .map((k) => `${rfc3986(k)}=${rfc3986(queryParams[k])}`)
    .join("&");

  const canonicalHeaders = `host:${host.toLowerCase()}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const scheme = url.protocol || "https:";
  const baseHost = publicDomain ? `${scheme}//${publicDomain}` : `${scheme}//${url.host}`;
  return `${baseHost}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/**
 * Storage adapter implementing 0% egress delivery via Cloudflare R2 presigned URLs.
 */
export class R2StorageAdapter implements StoragePort {
  private readonly accountId: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly region: string;
  private readonly publicDomain?: string;

  constructor(config: R2Config) {
    this.accountId = config.accountId;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.bucket = config.bucket;
    this.endpoint = config.endpoint || `https://${this.accountId}.r2.cloudflarestorage.com`;
    this.region = config.region || "auto";
    this.publicDomain = config.publicDomain;
  }

  async createSignedDownloadUrl(
    path: string,
    expiresInSeconds: number,
    now: Date = new Date(),
  ): Promise<string | null> {
    try {
      return generateR2PresignedUrl({
        endpoint: this.endpoint,
        bucket: this.bucket,
        key: path,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        region: this.region,
        expiresInSeconds,
        date: now,
        publicDomain: this.publicDomain,
      });
    } catch (err) {
      console.error("[r2-storage] Failed to generate presigned download URL:", err instanceof Error ? err.message : err);
      return null;
    }
  }
}

export interface SupabaseStorageAdmin {
  storage: {
    from: (bucket: string) => {
      createSignedUrl: (path: string, expiresIn: number) => Promise<{
        data: { signedUrl: string } | null;
        error: { message?: string } | null;
      }>;
    };
  };
}

/**
 * Storage adapter targeting Supabase Storage (fallback path when R2 is unconfigured).
 */
export class SupabaseStorageAdapter implements StoragePort {
  constructor(
    private readonly sbAdmin: SupabaseStorageAdmin,
    private readonly bucket: string,
  ) {}

  async createSignedDownloadUrl(path: string, expiresInSeconds: number): Promise<string | null> {
    try {
      const { data, error } = await this.sbAdmin.storage.from(this.bucket).createSignedUrl(path, expiresInSeconds);
      if (error || !data?.signedUrl) {
        console.error("[supabase-storage] createSignedUrl failed:", error?.message ?? "no signedUrl");
        return null;
      }
      return data.signedUrl;
    } catch (err) {
      console.error("[supabase-storage] exception during createSignedUrl:", err instanceof Error ? err.message : err);
      return null;
    }
  }
}

export interface DeliveryStorageOptions {
  bucket?: string;
  forceR2?: boolean;
}

/**
 * Factory for the delivery storage adapter.
 * Prefers Cloudflare R2 when credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
 * are present, providing 0% egress delivery fees. Falls back to Supabase Storage if R2
 * is unconfigured or if R2 URL generation fails.
 */
export function getDeliveryStorageAdapter(
  sbAdmin: SupabaseStorageAdmin,
  bucket: string = GLOBAL.delivery.bucket,
): StoragePort {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const r2Bucket = process.env.R2_BUCKET_NAME || process.env.CLOUDFLARE_R2_BUCKET || bucket;

  if (accountId && accessKeyId && secretAccessKey) {
    const r2Adapter = new R2StorageAdapter({
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket: r2Bucket,
      endpoint: process.env.R2_ENDPOINT,
      region: process.env.R2_REGION,
      publicDomain: process.env.R2_PUBLIC_URL || process.env.R2_CUSTOM_DOMAIN,
    });

    return {
      async createSignedDownloadUrl(path: string, expiresInSeconds: number): Promise<string | null> {
        const url = await r2Adapter.createSignedDownloadUrl(path, expiresInSeconds);
        if (url) return url;
        console.warn("[delivery-storage] R2 URL generation returned null; falling back to Supabase Storage");
        const fallback = new SupabaseStorageAdapter(sbAdmin, bucket);
        return fallback.createSignedDownloadUrl(path, expiresInSeconds);
      },
    };
  }

  // R2 credentials unset: fallback to Supabase Storage
  return new SupabaseStorageAdapter(sbAdmin, bucket);
}
