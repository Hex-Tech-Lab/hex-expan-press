import dotenv from "dotenv";
dotenv.config({ override: true });

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { putR2ObjectIf, statR2Object, type StatR2ObjectResult } from "../src/adapters/storage/r2.adapter";

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

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing required Supabase environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY");
  }

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
      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from(supabaseBucket)
        .download(filePath);

      if (downloadError || !fileBlob) {
        const errMsg = downloadError?.message || "Empty download blob";
        logger.error(`   ❌ Failed to download ${filePath}: ${errMsg}`);
        summary.failed++;
        summary.errors.push({ path: filePath, error: errMsg });
        continue;
      }

      const arrayBuffer = await fileBlob.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const contentType = file.mimetype || "application/pdf";

      logger.log(`   📤 Uploading to Cloudflare R2 (${buffer.byteLength} bytes, ${contentType})...`);
      // Create-once when absent. Refresh only against the ETag just read, so a concurrent writer
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

// Direct execution via CLI (e.g. `pnpm dlx tsx scripts/sync-supabase-to-r2.ts` or `tsx scripts/sync-supabase-to-r2.ts`)
if (process.argv[1] && process.argv[1].includes("sync-supabase-to-r2")) {
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
