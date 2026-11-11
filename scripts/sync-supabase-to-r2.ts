import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { putR2ObjectIf, statR2Object, type StatR2ObjectResult } from "../src/adapters/storage/r2.adapter";
import { GLOBAL } from "../payments/src/settings_registry.ts";

export interface SyncOptions {
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseBucket?: string;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2BucketName?: string;
  r2Endpoint?: string;
  r2Region?: string;
  prefix?: string;
  dryRun?: boolean;
  supabaseClient?: SupabaseClient;
  fetchImpl?: typeof fetch;
  /** Fetch used for the Supabase object GET. Defaults to fetchImpl. Kept separate so tests can script each side. */
  sourceFetchImpl?: typeof fetch;
  logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/** A Supabase Storage object as listed. `etag` is the source version the sync compares against R2. */
export interface SyncFile {
  path: string;
  mimetype?: string;
  size?: number;
  etag?: string;
}

export interface SyncResult {
  totalFound: number;
  alreadySynced: number;
  uploaded: number;
  verified: number;
  failed: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Parses `--prefix <val>` or `--prefix=<val>` from CLI arguments.
 * Returns undefined only when the flag is absent. A present flag with no usable value throws,
 * so a malformed flag can never fall back to listing the whole bucket.
 */
export function parsePrefixArg(argv: string[] = process.argv): string | undefined {
  const invalid = (detail: string) =>
    new Error(`--prefix ${detail}; pass a folder such as --prefix releases/v1 or --prefix=releases/v1`);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--prefix=")) {
      const value = arg.slice("--prefix=".length);
      if (value === "") throw invalid("was given an empty value");
      return value;
    }
    if (arg === "--prefix") {
      const next = argv[i + 1];
      if (next === undefined || next === "") throw invalid("has no value");
      if (next.startsWith("--")) throw invalid(`was followed by the flag ${next} instead of a value`);
      return next;
    }
  }
  return undefined;
}
export const parsePrefix = parsePrefixArg;
export const parseCliPrefix = parsePrefixArg;

/**
 * Refuses any Supabase URL that is not https; loopback http (localhost, 127.0.0.1, [::1]) is allowed for local development. The service key is a
 * Bearer credential, so this must run before any request that carries it, including the bucket listing.
 */
export function assertSecureSupabaseUrl(supabaseUrl: string): void {
  const parsed = new URL(supabaseUrl);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`SUPABASE_URL must be https (got ${parsed.protocol}//${parsed.hostname}); the service key is sent as a Bearer token`);
  }
}

/**
 * Downloads one object with a single GET. The bytes and the ETag header come from the same response, so the
 * ETag describes exactly these bytes. Throws on a non-2xx status. A network error propagates to the caller.
 */
export async function fetchSourceObject(
  fetchImpl: typeof fetch,
  supabaseUrl: string,
  supabaseKey: string,
  bucket: string,
  filePath: string,
  maxBytes: number = GLOBAL.payments.sync_max_object_bytes,
): Promise<{ bytes: Buffer; etag: string | undefined }> {
  assertSecureSupabaseUrl(supabaseUrl);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`;
  // Bounded: a stalled GET aborts (the signal also covers reading the body) and the file is recorded as failed.
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(GLOBAL.payments.sync_http_timeout_ms),
  });
  if (!res.ok) {
    // Release the socket now rather than leaving the unread body to garbage collection.
    await res.body?.cancel();
    throw new Error(`Supabase download of ${filePath} returned HTTP ${res.status}`);
  }
  const etag = res.headers.get("etag") ?? undefined;
  return { bytes: await readBounded(res, filePath, maxBytes), etag };
}

/**
 * Reads a response body with a hard byte cap. A declared Content-Length over the cap is refused before any
 * byte is read. Otherwise the stream is counted and cancelled as soon as it passes the cap, so memory is bounded
 * even when the server lies about its length. An identity-encoded body whose length differs from its declared length is refused.
 */
async function readBounded(res: Response, filePath: string, maxBytes: number): Promise<Buffer> {
  const declared = res.headers.get("content-length");
  if (declared !== null && !/^\d+$/.test(declared)) {
    throw new Error(`Supabase object ${filePath} has a non-numeric content-length`);
  }
  if (declared !== null && Number(declared) > maxBytes) {
    await res.body?.cancel();
    throw new Error(`Supabase object ${filePath} declares ${declared} bytes, over the ${maxBytes}-byte cap`);
  }
  if (!res.body) {
    // A declared non-empty length with no body is a truncated or broken response, not an empty object.
    if (declared !== null && Number(declared) > 0) {
      throw new Error(`Supabase object ${filePath} declared ${declared} bytes but returned no body`);
    }
    return Buffer.alloc(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Supabase object ${filePath} exceeded the ${maxBytes}-byte cap while streaming`);
      }
      chunks.push(value);
    }
  } finally {
    // Always release the lock so an error or early return never leaves the stream locked and the connection open.
    reader.releaseLock();
  }
  // Identity-encoded bodies must match the declared length. A content-encoded body (gzip, br, ...) declares its
  // compressed size, so the comparison would be wrong there and is skipped.
  const encoding = res.headers.get("content-encoding");
  if (declared !== null && (encoding ?? "identity").toLowerCase() === "identity" && total !== Number(declared)) {
    throw new Error(`Supabase object ${filePath} declared ${declared} bytes but delivered ${total}`);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Recursively lists all file keys in a Supabase Storage bucket.
 */
export async function listAllSupabaseFiles(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string = "",
): Promise<SyncFile[]> {
  const result: SyncFile[] = [];
  const limit = 1000;
  let offset = 0;
  const allItems: Array<{ name: string; id?: string | null; metadata?: Record<string, unknown> | null }> = [];

  while (true) {
    const { data: items, error } = await supabase.storage.from(bucket).list(prefix, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });

    if (error) {
      throw new Error(`Failed to list files from Supabase Storage bucket [${bucket}] at path [${prefix}]: ${error.message}`);
    }

    if (!items || items.length === 0) {
      break;
    }

    allItems.push(...items);

    if (items.length < limit) {
      break;
    }

    offset += limit;
  }

  if (allItems.length === 0) {
    return result;
  }

  for (const item of allItems) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name;

    // In Supabase Storage, folders have id === null (or no id)
    if (!item.id) {
      const nested = await listAllSupabaseFiles(supabase, bucket, fullPath);
      result.push(...nested);
    } else {
      result.push({
        path: fullPath,
        etag: (item.metadata as { eTag?: string })?.eTag,
        mimetype: (item.metadata as { mimetype?: string })?.mimetype || "application/octet-stream",
        size: (item.metadata as { size?: number })?.size,
      });
    }
  }

  return result;
}

/**
 * Synchronizes files from Supabase Storage to Cloudflare R2 with zero extra dependencies.
 */
export async function syncSupabaseToR2(options: SyncOptions = {}): Promise<SyncResult> {
  const logger = options.logger || console;

  const supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL || "";
  const supabaseKey =
    options.supabaseServiceRoleKey ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    "";
  const supabaseBucket = options.supabaseBucket || process.env.SUPABASE_STORAGE_BUCKET || "release-files";

  const r2AccountId =
    options.r2AccountId ||
    process.env.R2_ACCOUNT_ID ||
    process.env.CLOUDFLARE_R2_ACCOUNT_ID ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    "";
  const r2AccessKeyId =
    options.r2AccessKeyId ||
    process.env.R2_ACCESS_KEY_ID ||
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ||
    "";
  const r2SecretAccessKey =
    options.r2SecretAccessKey ||
    process.env.R2_SECRET_ACCESS_KEY ||
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ||
    "";
  const r2BucketName =
    options.r2BucketName ||
    process.env.R2_BUCKET_NAME ||
    process.env.CLOUDFLARE_R2_BUCKET ||
    process.env.CLOUDFLARE_R2_BUCKET_NAME ||
    "";
  const r2Region = options.r2Region || process.env.R2_REGION || "auto";
  const r2Endpoint =
    options.r2Endpoint ||
    process.env.R2_ENDPOINT ||
    (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : "");

  const dryRun = options.dryRun ?? process.argv.includes("--dry-run");
  const prefix = options.prefix ?? parsePrefixArg(process.argv) ?? "";
  // An empty programmatic prefix would list the whole bucket. Reject it before any listing call.
  if (options.prefix === "") {
    throw new Error('Empty prefix: options.prefix must name a folder such as "releases/v1"; omit it to sync the whole bucket');
  }
  const fetchImpl = options.fetchImpl || fetch;
  const sourceFetchImpl = options.sourceFetchImpl || fetchImpl;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing required Supabase environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY");
  }

  // Refuse a non-https Supabase URL before any call that carries the service key, including the listing.
  assertSecureSupabaseUrl(supabaseUrl);

  if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey || !r2BucketName) {
    throw new Error("Missing required Cloudflare R2 environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME");
  }

  const supabase =
    options.supabaseClient ||
    createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });

  logger.log(`\n======================================================`);
  logger.log(`🚀 Supabase Storage -> Cloudflare R2 Synchronization`);
  logger.log(`   Source: Supabase bucket [${supabaseBucket}]`);
  logger.log(`   Target: R2 bucket [${r2BucketName}] on endpoint [${r2Endpoint}]`);
  if (dryRun) logger.log(`   Mode: DRY RUN (no uploads will be performed)`);
  if (prefix) logger.log(`   Prefix filter: [${prefix}]`);
  logger.log(`======================================================\n`);

  const files = await listAllSupabaseFiles(supabase, supabaseBucket, prefix);
  logger.log(`📁 Found ${files.length} file(s) in Supabase Storage bucket.`);

  const summary: SyncResult = {
    totalFound: files.length,
    alreadySynced: 0,
    uploaded: 0,
    verified: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (const file of files) {
    // Per-file isolation: an unexpected throw while handling one file is recorded and the run continues.
    try {
      const filePath = file.path;
      logger.log(`\n🔍 Checking: ${filePath}`);

      // Without the source ETag there is no version to compare or record, so the copy cannot be proven fresh.
      if (!file.etag) {
        logger.error(`   ❌ Supabase listing returned no ETag for ${filePath}; refusing to sync an unversioned object.`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: "Supabase listing returned no ETag" });
        continue;
      }

      let remote: StatR2ObjectResult;
      try {
        remote = await statR2Object({
          endpoint: r2Endpoint,
          bucket: r2BucketName,
          key: filePath,
          accessKeyId: r2AccessKeyId,
          secretAccessKey: r2SecretAccessKey,
          region: r2Region,
          fetchImpl,
        });
      } catch (headErr) {
        const errMsg = headErr instanceof Error ? headErr.message : String(headErr);
        logger.error(`   ❌ Failed HEAD check on R2 for ${filePath}: ${errMsg}`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: `R2 HEAD check failed: ${errMsg}` });
        continue;
      }

      // Skip only on an exact source-ETag match. Presence alone proves nothing about freshness.
      if (remote.exists && remote.sourceEtag === file.etag) {
        logger.log(`   ✅ Up to date in Cloudflare R2 (source ETag matches).`);
        summary.alreadySynced++;
        continue;
      }

      if (remote.exists && !remote.etag) {
        logger.error(`   ❌ R2 returned no ETag for ${filePath}; refusing an unconditioned overwrite.`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: "R2 returned no ETag; overwrite not conditioned" });
        continue;
      }

      if (remote.exists) {
        logger.log(`   ♻️ Stale or unversioned copy in R2 (source ETag ${remote.sourceEtag ?? "missing"}); refreshing.`);
      }

      if (dryRun) {
        logger.log(`   ℹ️ [DRY RUN] Would download from Supabase and upload to R2.`);
        summary.skipped++;
        continue;
      }

      logger.log(`   📥 Downloading from Supabase Storage...`);
      // One GET returns the bytes and the ETag of those bytes. The write is refused unless the served ETag equals the
      // listed ETag, so the stamped "supabase-etag" (the listed value) is also the ETag of the bytes written. A change
      // after listing makes the served ETag differ, and the bytes are refused. A revert (A to B to A) serves A's bytes
      // with A's ETag, so it is accepted and correct.
      const source = await fetchSourceObject(sourceFetchImpl, supabaseUrl, supabaseKey, supabaseBucket, filePath);
      if (!source.etag) {
        logger.error(`   ❌ Supabase download of ${filePath} returned no ETag; refusing to write unversioned bytes.`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: "Supabase download returned no ETag" });
        continue;
      }
      if (source.etag !== file.etag) {
        logger.error(`   ❌ ${filePath} changed in Supabase after it was listed (listed ${file.etag}, served ${source.etag}); refusing to write these bytes. Re-run the sync.`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: "source changed between listing and download; re-run sync" });
        continue;
      }
      const buffer = source.bytes;
      const contentType = file.mimetype || "application/pdf";

      logger.log(`   📤 Uploading to Cloudflare R2 (${buffer.byteLength} bytes, ${contentType})...`);
      // Create-once when absent. Refresh only against the ETag read by the HEAD earlier in this item, so a concurrent writer
      // makes this PUT fail with 412 instead of being overwritten by older bytes.
      const precondition = remote.exists ? { ifMatch: remote.etag } : { ifNoneMatch: "*" as const };
      const put = await putR2ObjectIf({
        endpoint: r2Endpoint,
        bucket: r2BucketName,
        key: filePath,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        region: r2Region,
        body: buffer,
        contentType,
        fetchImpl,
        metadata: { "supabase-etag": file.etag },
        ...precondition,
      });

      if (put.status === "precondition_failed") {
        logger.error(`   ❌ R2 rejected the write for ${filePath}: the object changed after it was read. Re-run the sync.`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: "R2 precondition failed (concurrent write); re-run sync" });
        continue;
      }

      if (put.status === "failed") {
        logger.error(`   ❌ Failed to upload ${filePath} to Cloudflare R2: ${put.reason}`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: `R2 PUT request failed: ${put.reason}` });
        continue;
      }

      // Written: counted before verification, so a failed check never hides a successful write.
      summary.uploaded++;

      logger.log(`   🩺 Verifying uploaded object in Cloudflare R2...`);
      try {
        const after = await statR2Object({
          endpoint: r2Endpoint,
          bucket: r2BucketName,
          key: filePath,
          accessKeyId: r2AccessKeyId,
          secretAccessKey: r2SecretAccessKey,
          region: r2Region,
          fetchImpl,
        });
        if (after.exists && after.sourceEtag === file.etag) {
          logger.log(`   ✨ Successfully uploaded and verified in R2!`);
          summary.verified++;
        } else {
          logger.warn(`   ⚠️ WARNING: Uploaded ${filePath} but its source ETag did not verify in R2.`);
          summary.failed++;
          summary.errors.push({ path: filePath, error: "Post-upload source ETag verification failed" });
        }
      } catch (verifyErr) {
        const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        logger.warn(`   ⚠️ Post-upload verification request failed for ${filePath}: ${errMsg}`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: `Post-upload verification failed: ${errMsg}` });
      }
    } catch (fileErr) {
      const errMsg = String(fileErr);
      logger.error(`   ❌ Unexpected error while syncing ${file.path}: ${errMsg}`);
      summary.failed++;
      summary.errors.push({ path: file.path, error: errMsg });
    }
  }

  logger.log(`\n======================================================`);
  logger.log(`🏁 Sync summary:`);
  logger.log(`   Total files:     ${summary.totalFound}`);
  logger.log(`   Already synced:  ${summary.alreadySynced}`);
  logger.log(`   Uploaded:        ${summary.uploaded}`);
  logger.log(`   Verified:        ${summary.verified}`);
  logger.log(`   Skipped:         ${summary.skipped}`);
  logger.log(`   Failed:          ${summary.failed}`);
  logger.log(`======================================================\n`);

  return summary;
}

/**
 * True only when argv1 is this file. A substring test would also match lookalike names. tsx reports argv[1] without
 * the .ts extension when the script is named without it, so that form is accepted too (HEAD's substring test ran it).
 */
export function isDirectRun(argv1: string | undefined): boolean {
  if (!argv1) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const invoked = path.resolve(argv1);
  return invoked === self || invoked === self.replace(/\.ts$/, "");
}

/**
 * Loads the repo-root .env for direct CLI runs only. Importing this module must not read live keys.
 * override: true per AGENTS.md: without it a stale shell variable (e.g. R2_ACCOUNT_ID) silently beats .env,
 * and an upload could target the wrong R2 account. The path is anchored to this file, not the working directory.
 */
export function loadEnvForCli(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  dotenv.config({ override: true, path: path.join(repoRoot, ".env") });
}

// Direct execution via CLI (e.g. `pnpm dlx tsx scripts/sync-supabase-to-r2.ts` or `tsx scripts/sync-supabase-to-r2.ts`)
if (isDirectRun(process.argv[1])) {
  loadEnvForCli();
  // parsePrefixArg runs inside the promise chain so a malformed --prefix reaches the .catch handler.
  Promise.resolve()
    .then(() => syncSupabaseToR2({ prefix: parsePrefixArg(process.argv) }))
    .then((result) => {
      if (result.failed > 0) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error("💥 Fatal error during sync script execution:", err);
      process.exit(1);
    });
}
