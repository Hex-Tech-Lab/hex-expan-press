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
  /** @deprecated Cloudflare rejects S3 presigned URLs on custom domains; ignored */
  publicDomain?: string;
  fetchImpl?: typeof fetch;
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

/**
 * Derives the AWS SigV4 signing key for a given date, region, and service.
 */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string = "s3",
): Buffer {
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Builds the canonical request and returns the signed headers string.
 */
/**
 * SigV4 canonical headers. The host is always signed. Extra headers (write preconditions,
 * x-amz-meta-*) are signed as well, so R2 authenticates them and they cannot be altered in transit.
 */
function canonicalHeaderBlock(
  host: string,
  extraHeaders: Record<string, string>,
): { canonicalHeaders: string; signedHeaders: string } {
  const entries: Array<[string, string]> = [["host", host.toLowerCase()]];
  for (const [name, value] of Object.entries(extraHeaders)) {
    entries.push([name.toLowerCase(), value.trim()]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonicalHeaders: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders: entries.map(([name]) => name).join(";"),
  };
}

export function buildCanonicalRequest(
  method: string,
  canonicalUri: string,
  canonicalQueryString: string,
  host: string,
  extraHeaders: Record<string, string> = {},
): { canonicalRequest: string; signedHeaders: string } {
  const { canonicalHeaders, signedHeaders } = canonicalHeaderBlock(host, extraHeaders);
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  return { canonicalRequest, signedHeaders };
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
  /** @deprecated Cloudflare rejects S3 presigned URLs on custom domains; ignored */
  publicDomain?: string;
  method?: string;
  /** Headers the caller will send unchanged; they are signed so R2 authenticates them. */
  signHeaders?: Record<string, string>;
}

/**
 * Generates an AWS SigV4 Presigned URL for Cloudflare R2 / S3-compatible storage.
 * Always signs and returns URLs using the S3 API endpoint's host (<accountid>.r2.cloudflarestorage.com).
 * Runs in pure Node.js (node:crypto) with 0 third-party dependencies.
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
    method = "GET",
    signHeaders = {},
  } = options;

  const url = new URL(endpoint);
  // Always use the S3 API endpoint host (Cloudflare rejects S3 presigned URLs on custom domains).
  const host = url.host;

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
    "X-Amz-SignedHeaders": canonicalHeaderBlock(host, signHeaders).signedHeaders,
  };

  const sortedParamKeys = Object.keys(queryParams).sort();
  const canonicalQueryString = sortedParamKeys
    .map((k) => `${rfc3986(k)}=${rfc3986(queryParams[k])}`)
    .join("&");

  const { canonicalRequest } = buildCanonicalRequest(
    method,
    canonicalUri,
    canonicalQueryString,
    host,
    signHeaders,
  );

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kSigning = deriveSigningKey(secretAccessKey, dateStamp, region);
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const scheme = url.protocol || "https:";
  return `${scheme}//${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

export interface HeadR2ObjectOptions {
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Header carrying the source ETag recorded when the object was written (metadata key `supabase-etag`). */
export const SOURCE_ETAG_HEADER = "x-amz-meta-supabase-etag";

export interface StatR2ObjectResult {
  exists: boolean;
  /** R2's own ETag for the stored bytes. The If-Match precondition for a refresh. */
  etag?: string;
  /** Source ETag stored with the object. Absent on objects written before the freshness contract. */
  sourceEtag?: string;
}

/**
 * Reads an object's state in Cloudflare R2 with a bounded signed HEAD request.
 * Returns exists:false ONLY on confirmed absence (404). Any other non-2xx status,
 * network error, or timeout throws, so callers never treat an inconclusive read as absence.
 */
export async function statR2Object(options: HeadR2ObjectOptions): Promise<StatR2ObjectResult> {
  const {
    endpoint,
    bucket,
    key,
    accessKeyId,
    secretAccessKey,
    region = "auto",
    fetchImpl = fetch,
    timeoutMs = 5000,
  } = options;

  const parsedUrl = new URL(endpoint);
  if (parsedUrl.protocol === "http:" && process.env.R2_ALLOW_INSECURE_HTTP !== "true") {
    throw new Error(`[r2-storage] Insecure HTTP endpoint rejected: ${endpoint}`);
  }

  const headUrl = generateR2PresignedUrl({
    endpoint,
    bucket,
    key,
    accessKeyId,
    secretAccessKey,
    region,
    expiresInSeconds: 60,
    method: "HEAD",
  });

  const res = await fetchImpl(headUrl, {
    method: "HEAD",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 404) {
    return { exists: false };
  }

  if (!res.ok) {
    throw new Error(`[r2-storage] HEAD object returned status ${res.status}`);
  }

  return {
    exists: true,
    etag: res.headers.get("etag") ?? undefined,
    sourceEtag: res.headers.get(SOURCE_ETAG_HEADER) ?? undefined,
  };
}

/** Boolean view of statR2Object: true on 2xx, false only on confirmed 404, throws otherwise. */
export async function headR2Object(options: HeadR2ObjectOptions): Promise<boolean> {
  return (await statR2Object(options)).exists;
}

export interface PutR2ObjectOptions {
  endpoint: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Uploads an object to Cloudflare R2 using a signed PUT request.
 * Returns true if the upload succeeded (2xx), false otherwise.
 */
export async function putR2Object(options: PutR2ObjectOptions): Promise<boolean> {
  const {
    endpoint,
    bucket,
    key,
    accessKeyId,
    secretAccessKey,
    region = "auto",
    body,
    contentType = "application/octet-stream",
    fetchImpl = fetch,
    timeoutMs = 30000,
  } = options;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch (err) {
    console.warn(`[r2-storage] PUT object failed:`, err instanceof Error ? err.message : err);
    return false;
  }
  if (parsedUrl.protocol === "http:" && process.env.R2_ALLOW_INSECURE_HTTP !== "true") {
    throw new Error(`[r2-storage] Insecure HTTP endpoint rejected: ${endpoint}`);
  }

  try {
    const putUrl = generateR2PresignedUrl({
      endpoint,
      bucket,
      key,
      accessKeyId,
      secretAccessKey,
      region,
      expiresInSeconds: 300,
      method: "PUT",
    });

    const res = await fetchImpl(putUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
      body: (body instanceof Uint8Array ? body : typeof body === "string" ? body : Buffer.from(body)) as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      console.warn(`[r2-storage] PUT object returned status ${res.status}`);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[r2-storage] PUT object failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

export interface PutR2ObjectIfOptions extends PutR2ObjectOptions {
  /** Stored as x-amz-meta-<name> headers. Signed. */
  metadata?: Record<string, string>;
  /** Write only if the stored object's ETag equals this value (refresh). */
  ifMatch?: string;
  /** Write only if no object exists at the key ("*" for create-once). */
  ifNoneMatch?: string;
}

export type PutR2ObjectResult =
  | { status: "written" }
  | { status: "precondition_failed" }
  | { status: "failed"; reason: string };

/**
 * Conditional signed PUT. R2 evaluates If-Match / If-None-Match atomically against the committed
 * object, so a write based on a stale read fails with 412 instead of silently overwriting.
 * Throws on an insecure endpoint (same guard as putR2Object); any other failure is returned.
 */
export async function putR2ObjectIf(options: PutR2ObjectIfOptions): Promise<PutR2ObjectResult> {
  const {
    endpoint,
    bucket,
    key,
    accessKeyId,
    secretAccessKey,
    region = "auto",
    body,
    contentType = "application/octet-stream",
    fetchImpl = fetch,
    timeoutMs = 30000,
    metadata = {},
    ifMatch,
    ifNoneMatch,
  } = options;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (parsedUrl.protocol === "http:" && process.env.R2_ALLOW_INSECURE_HTTP !== "true") {
    throw new Error(`[r2-storage] Insecure HTTP endpoint rejected: ${endpoint}`);
  }

  const conditionalHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata)) {
    conditionalHeaders[`x-amz-meta-${name.toLowerCase()}`] = value;
  }
  if (ifMatch !== undefined) conditionalHeaders["if-match"] = ifMatch;
  if (ifNoneMatch !== undefined) conditionalHeaders["if-none-match"] = ifNoneMatch;

  try {
    const putUrl = generateR2PresignedUrl({
      endpoint,
      bucket,
      key,
      accessKeyId,
      secretAccessKey,
      region,
      expiresInSeconds: 300,
      method: "PUT",
      signHeaders: conditionalHeaders,
    });

    const res = await fetchImpl(putUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        ...conditionalHeaders,
      },
      body: (body instanceof Uint8Array ? body : typeof body === "string" ? body : Buffer.from(body)) as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 412) {
      return { status: "precondition_failed" };
    }
    if (!res.ok) {
      return { status: "failed", reason: `PUT object returned status ${res.status}` };
    }
    return { status: "written" };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
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
  private readonly fetchImpl: typeof fetch;

  constructor(config: R2Config) {
    this.accountId = config.accountId;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.bucket = config.bucket;
    this.endpoint = config.endpoint || `https://${this.accountId}.r2.cloudflarestorage.com`;
    this.region = config.region || "auto";
    this.fetchImpl = config.fetchImpl || fetch;
  }

  async hasObject(path: string): Promise<boolean> {
    return headR2Object({
      endpoint: this.endpoint,
      bucket: this.bucket,
      key: path,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      fetchImpl: this.fetchImpl,
    });
  }

  async uploadObject(
    path: string,
    body: Buffer | Uint8Array | string,
    contentType = "application/octet-stream",
  ): Promise<boolean> {
    return putR2Object({
      endpoint: this.endpoint,
      bucket: this.bucket,
      key: path,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      body,
      contentType,
      fetchImpl: this.fetchImpl,
    });
  }

  async createSignedDownloadUrl(
    path: string,
    expiresInSeconds: number,
    now: Date = new Date(),
  ): Promise<string | null> {
    try {
      const exists = await headR2Object({
        endpoint: this.endpoint,
        bucket: this.bucket,
        key: path,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        region: this.region,
        fetchImpl: this.fetchImpl,
      });

      if (!exists) {
        return null;
      }

      return generateR2PresignedUrl({
        endpoint: this.endpoint,
        bucket: this.bucket,
        key: path,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        region: this.region,
        expiresInSeconds,
        date: now,
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

/**
 * Composite storage adapter that attempts primary storage first, falling back to secondary storage
 * if the primary adapter returns null (e.g. object missing in R2 or URL generation failure).
 */
export class CompositeStorageAdapter implements StoragePort {
  constructor(
    private readonly primary: StoragePort,
    private readonly fallback: StoragePort,
  ) {}

  async createSignedDownloadUrl(path: string, expiresInSeconds: number): Promise<string | null> {
    const url = await this.primary.createSignedDownloadUrl(path, expiresInSeconds);
    if (url) return url;
    console.warn("[delivery-storage] Primary storage returned null; falling back to secondary storage");
    return this.fallback.createSignedDownloadUrl(path, expiresInSeconds);
  }
}

export interface DeliveryStorageOptions {
  bucket?: string;
  forceR2?: boolean;
}

/**
 * Factory for the delivery storage adapter.
 * Prefers Cloudflare R2 when credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
 * and an explicit R2_BUCKET_NAME are present, providing 0% egress delivery fees.
 * Falls back to Supabase Storage if R2 is unconfigured or if R2 object presence / URL generation fails.
 */
export function getDeliveryStorageAdapter(
  sbAdmin: SupabaseStorageAdmin,
  bucket: string = GLOBAL.delivery.bucket,
): StoragePort {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const r2Bucket = process.env.R2_BUCKET_NAME || process.env.CLOUDFLARE_R2_BUCKET;

  const fallback = new SupabaseStorageAdapter(sbAdmin, bucket);

  if (accountId && accessKeyId && secretAccessKey && r2Bucket) {
    const r2Adapter = new R2StorageAdapter({
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket: r2Bucket,
      endpoint: process.env.R2_ENDPOINT,
      region: process.env.R2_REGION,
    });

    return new CompositeStorageAdapter(r2Adapter, fallback);
  }

  // R2 credentials or bucket unset: fallback to Supabase Storage
  return fallback;
}
