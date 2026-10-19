import dotenv from "dotenv";
dotenv.config();

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { headR2Object, putR2Object } from "../src/adapters/storage/r2.adapter";

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
 * Recursively lists all file keys in a Supabase Storage bucket.
 */
export async function listAllSupabaseFiles(
  supabase: SupabaseClient,
  bucket: string,
  prefix: string = "",
): Promise<Array<{ path: string; mimetype?: string; size?: number }>> {
  const result: Array<{ path: string; mimetype?: string; size?: number }> = [];

  const { data: items, error } = await supabase.storage.from(bucket).list(prefix, {
    limit: 1000,
    offset: 0,
    sortBy: { column: "name", order: "asc" },
  });

  if (error) {
    throw new Error(`Failed to list files from Supabase Storage bucket [${bucket}] at path [${prefix}]: ${error.message}`);
  }

  if (!items || items.length === 0) {
    return result;
  }

  for (const item of items) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name;

    // In Supabase Storage, folders have id === null (or no id)
    if (!item.id) {
      const nested = await listAllSupabaseFiles(supabase, bucket, fullPath);
      result.push(...nested);
    } else {
      result.push({
        path: fullPath,
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
  const supabaseKey = options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabaseBucket = options.supabaseBucket || process.env.SUPABASE_STORAGE_BUCKET || "release-files";

  const r2AccountId = options.r2AccountId || process.env.R2_ACCOUNT_ID || "";
  const r2AccessKeyId = options.r2AccessKeyId || process.env.R2_ACCESS_KEY_ID || "";
  const r2SecretAccessKey = options.r2SecretAccessKey || process.env.R2_SECRET_ACCESS_KEY || "";
  const r2BucketName = options.r2BucketName || process.env.R2_BUCKET_NAME || process.env.CLOUDFLARE_R2_BUCKET || "";
  const r2Region = options.r2Region || process.env.R2_REGION || "auto";
  const r2Endpoint =
    options.r2Endpoint ||
    process.env.R2_ENDPOINT ||
    (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : "");

  const dryRun = options.dryRun ?? process.argv.includes("--dry-run");
  const prefix = options.prefix ?? "";
  const fetchImpl = options.fetchImpl || fetch;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing required Supabase environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
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
    const filePath = file.path;
    logger.log(`\n🔍 Checking: ${filePath}`);

    // Check if file already exists in R2
    let existsInR2 = false;
    try {
      existsInR2 = await headR2Object({
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

    if (existsInR2) {
      logger.log(`   ✅ Already present and verified in Cloudflare R2.`);
      summary.alreadySynced++;
      continue;
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
    const putSuccess = await putR2Object({
      endpoint: r2Endpoint,
      bucket: r2BucketName,
      key: filePath,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
      region: r2Region,
      body: buffer,
      contentType,
      fetchImpl,
    });

    if (!putSuccess) {
      logger.error(`   ❌ Failed to upload ${filePath} to Cloudflare R2.`);
      summary.failed++;
      summary.errors.push({ path: filePath, error: "R2 PUT request failed" });
      continue;
    }

    // Post-upload verification health check (HEAD request)
    logger.log(`   🩺 Verifying uploaded object in Cloudflare R2...`);
    let verified = false;
    try {
      verified = await headR2Object({
        endpoint: r2Endpoint,
        bucket: r2BucketName,
        key: filePath,
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
        region: r2Region,
        fetchImpl,
      });
    } catch (verifyErr) {
      const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      logger.warn(`   ⚠️ Post-upload verification HEAD request failed for ${filePath}: ${errMsg}`);
      verified = false;
    }

    if (verified) {
      logger.log(`   ✨ Successfully uploaded and verified in R2!`);
      summary.uploaded++;
      summary.verified++;
    } else {
      logger.warn(`   ⚠️ WARNING: Uploaded ${filePath} but post-upload HEAD verification failed!`);
      summary.failed++;
      summary.errors.push({ path: filePath, error: "Post-upload HEAD verification failed" });
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
  syncSupabaseToR2()
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
