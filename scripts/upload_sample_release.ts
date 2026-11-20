/**
 * Upload the house sample release PDF to the configured Supabase delivery bucket
 * (`GLOBAL.delivery.bucket`), verifying SHA-256 and byte length before and after upload.
 *
 * Reads the book registry pointer from `GLOBAL.storefront.book_assets` (defaulting to
 * `sample_the_quiet_workshop`), loads file path, target object key, expected SHA-256,
 * and expected byte length from `books/<id>.json`, and reads timeout from
 * `GLOBAL.payments.sync_http_timeout_ms`.
 *
 * Never loads `.env` directly and never prints credential values.
 * Supports `--dry-run` (verifies local file size + SHA-256 without network writes).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBookIdentity, type BookIdentity } from "../payments/book_identity.ts";
import { GLOBAL } from "../payments/src/settings_registry.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const DEFAULT_SLUG = "sample_the_quiet_workshop";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const HTTP_MEANINGS: Record<number, string> = {
  200: "200 OK",
  201: "201 Created",
  400: "400 Bad Request",
  401: "401 Unauthorized",
  403: "403 Forbidden",
  404: "404 Not Found",
  409: "409 Conflict",
  413: "413 Payload Too Large",
  422: "422 Unprocessable Entity",
  429: "429 Too Many Requests",
  500: "500 Internal Server Error",
  502: "502 Bad Gateway",
  503: "503 Service Unavailable",
  504: "504 Gateway Timeout",
};

export function describeHttpStatus(status: number): string {
  return HTTP_MEANINGS[status] ?? `${status} HTTP Error`;
}

export interface SampleReleaseSpec {
  bucket: string;
  objectKey: string;
  expectedSha256: string;
  expectedBytes: number;
  localFile: string;
}

export interface UploadSampleReleaseResult {
  dryRun: boolean;
  bucket: string;
  objectKey: string;
  localFile: string;
  bytes: number;
  localSha256: string;
  expectedSha256: string;
  verifiedBefore: boolean;
  uploaded: boolean;
  alreadyExists: boolean;
  verifiedAfter: boolean;
  remoteSha256: string | null;
  remoteBytes: number | null;
  uploadStatus: string | null;
  verifyStatus: string | null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeRelativeSegment(value: string, label: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`upload_sample_release: unsafe ${label} "${value}"`);
  }
  return normalized;
}

export function resolveBookRegistryPath(bookArg?: string): string {
  const raw =
    bookArg ??
    GLOBAL.storefront.book_assets[DEFAULT_SLUG]?.book_registry ??
    "books/sample_the_quiet_workshop.json";
  const withExt = raw.trim().endsWith(".json") ? raw.trim() : `${raw.trim()}.json`;
  const safe = assertSafeRelativeSegment(withExt, "book_registry");
  if (!safe.startsWith("books/")) {
    throw new Error(`upload_sample_release: book registry "${raw}" must live under books/`);
  }
  const full = path.resolve(repoRoot, safe);
  if (!full.startsWith(`${path.resolve(repoRoot, "books")}${path.sep}`)) {
    throw new Error(`upload_sample_release: book registry "${raw}" escaped books/`);
  }
  return full;
}

function findGitCommonWorktreeRoot(): string | null {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commonDir || commonDir === ".git") return null;
    const resolvedGitDir = path.resolve(repoRoot, commonDir);
    if (path.basename(resolvedGitDir) !== ".git") return null;
    return path.dirname(resolvedGitDir);
  } catch {
    return null;
  }
}

export function resolveLocalReleaseFile(identity: BookIdentity, fileOverride?: string): string {
  if (fileOverride !== undefined) {
    const trimmed = fileOverride.trim();
    if (trimmed === "" || trimmed.split(/[\\/]/).includes("..")) {
      throw new Error(`upload_sample_release: invalid --file path "${fileOverride}"`);
    }
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    if (!existsSync(candidate)) {
      throw new Error(`upload_sample_release: local release file not found: ${candidate}`);
    }
    return candidate;
  }

  if (!identity.data_dir || !identity.release_pdf) {
    throw new Error(`upload_sample_release: book registry "${identity.id}" must define data_dir and release_pdf`);
  }
  const safeDir = assertSafeRelativeSegment(identity.data_dir, "data_dir");
  const safePdf = assertSafeRelativeSegment(identity.release_pdf, "release_pdf");
  const relPath = path.join(safeDir, safePdf);
  const localCandidate = path.resolve(repoRoot, relPath);
  if (localCandidate.startsWith(`${repoRoot}${path.sep}`) && existsSync(localCandidate)) {
    return localCandidate;
  }

  const commonRoot = findGitCommonWorktreeRoot();
  if (commonRoot) {
    const sharedCandidate = path.resolve(commonRoot, relPath);
    if (sharedCandidate.startsWith(`${commonRoot}${path.sep}`) && existsSync(sharedCandidate)) {
      return sharedCandidate;
    }
  }

  throw new Error(`upload_sample_release: local release file not found at ${localCandidate}`);
}

export function buildReleaseSpec(
  identity: BookIdentity,
  options: { fileOverride?: string; bucket?: string } = {},
): SampleReleaseSpec {
  const bucket = (options.bucket ?? GLOBAL.delivery.bucket).trim();
  if (!bucket || bucket.includes("/") || bucket.includes("..")) {
    throw new Error(`upload_sample_release: invalid delivery bucket "${bucket}"`);
  }
  if (!identity.release_path) {
    throw new Error(`upload_sample_release: book registry "${identity.id}" must define release_path`);
  }
  const objectKey = assertSafeRelativeSegment(identity.release_path, "release_path");
  const expectedSha256 = (identity.release_sha256 ?? "").trim().toLowerCase();
  if (!SHA256_HEX_RE.test(expectedSha256) || expectedSha256 === "0".repeat(64)) {
    throw new Error(`upload_sample_release: book registry "${identity.id}" has invalid release_sha256`);
  }
  if (typeof identity.release_bytes !== "number" || !Number.isInteger(identity.release_bytes) || identity.release_bytes <= 0) {
    throw new Error(`upload_sample_release: book registry "${identity.id}" must define positive integer release_bytes`);
  }
  const localFile = resolveLocalReleaseFile(identity, options.fileOverride);
  return {
    bucket,
    objectKey,
    expectedSha256,
    expectedBytes: identity.release_bytes,
    localFile,
  };
}

function validateSupabaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("upload_sample_release: missing SUPABASE_URL in environment");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("upload_sample_release: SUPABASE_URL is not a valid URL");
  }
  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) || parsed.username !== "" || parsed.password !== "") {
    throw new Error("upload_sample_release: SUPABASE_URL must be a clean https:// origin");
  }
  return trimmed;
}

function encodeStorageObjectUrl(baseUrl: string, bucket: string, objectKey: string): string {
  const encodedKey = objectKey.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedKey}`;
}

export async function uploadSampleRelease(options: {
  bookFile?: string;
  fileOverride?: string;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
} = {}): Promise<UploadSampleReleaseResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const dryRun = options.dryRun === true;

  const bookFile = options.bookFile ?? resolveBookRegistryPath();
  const identity = loadBookIdentity(bookFile);
  const spec = buildReleaseSpec(identity, { fileOverride: options.fileOverride });

  const stat = statSync(spec.localFile);
  if (!stat.isFile()) {
    throw new Error(`upload_sample_release: local path is not a regular file: ${spec.localFile}`);
  }
  const localBytes = new Uint8Array(readFileSync(spec.localFile));
  if (localBytes.byteLength !== spec.expectedBytes) {
    throw new Error(
      `upload_sample_release: refusing upload — local byte length ${localBytes.byteLength} differs from expected ${spec.expectedBytes}`,
    );
  }
  const localSha256 = sha256Hex(localBytes);
  if (localSha256 !== spec.expectedSha256) {
    throw new Error(
      `upload_sample_release: refusing upload — local sha256 ${localSha256} differs from expected ${spec.expectedSha256}`,
    );
  }

  if (dryRun) {
    return {
      dryRun: true,
      bucket: spec.bucket,
      objectKey: spec.objectKey,
      localFile: spec.localFile,
      bytes: localBytes.byteLength,
      localSha256,
      expectedSha256: spec.expectedSha256,
      verifiedBefore: true,
      uploaded: false,
      alreadyExists: false,
      verifiedAfter: false,
      remoteSha256: null,
      remoteBytes: null,
      uploadStatus: null,
      verifyStatus: null,
    };
  }

  const supabaseBase = validateSupabaseUrl(env.SUPABASE_URL);
  const serviceCredential = (env.SUPABASE_SECRET_KEY ?? "").trim();
  if (!serviceCredential) {
    throw new Error("upload_sample_release: missing SUPABASE_SECRET_KEY in environment");
  }

  const objectUrl = encodeStorageObjectUrl(supabaseBase, spec.bucket, spec.objectKey);
  const timeoutMs = GLOBAL.payments.sync_http_timeout_ms;

  const postRes = await fetchImpl(objectUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceCredential}`,
      apikey: serviceCredential,
      "Content-Type": "application/pdf",
      "x-upsert": "false",
    },
    body: localBytes,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const uploadStatus = describeHttpStatus(postRes.status);

  let uploaded = false;
  let alreadyExists = false;
  if (postRes.status === 200 || postRes.status === 201) {
    uploaded = true;
    await postRes.arrayBuffer().catch(() => undefined);
  } else if (postRes.status === 409) {
    alreadyExists = true;
    await postRes.arrayBuffer().catch(() => undefined);
  } else {
    const errBody = await postRes.text().catch(() => "");
    if (postRes.status === 400 && /already exists|duplicate/i.test(errBody)) {
      alreadyExists = true;
    } else {
      throw new Error(`upload_sample_release: POST ${spec.bucket}/${spec.objectKey} returned ${uploadStatus}`);
    }
  }

  const getRes = await fetchImpl(objectUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${serviceCredential}`,
      apikey: serviceCredential,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const verifyStatus = describeHttpStatus(getRes.status);
  if (getRes.status !== 200) {
    await getRes.arrayBuffer().catch(() => undefined);
    throw new Error(
      `upload_sample_release: post-upload GET ${spec.bucket}/${spec.objectKey} returned ${verifyStatus}`,
    );
  }

  const remoteBytes = new Uint8Array(await getRes.arrayBuffer());
  if (remoteBytes.byteLength !== spec.expectedBytes) {
    throw new Error(
      `upload_sample_release: post-upload size mismatch — remote ${remoteBytes.byteLength} bytes differs from expected ${spec.expectedBytes} bytes`,
    );
  }
  const remoteSha256 = sha256Hex(remoteBytes);
  if (remoteSha256 !== spec.expectedSha256) {
    throw new Error(
      `upload_sample_release: post-upload sha256 mismatch — remote ${remoteSha256} differs from expected ${spec.expectedSha256}`,
    );
  }

  return {
    dryRun: false,
    bucket: spec.bucket,
    objectKey: spec.objectKey,
    localFile: spec.localFile,
    bytes: localBytes.byteLength,
    localSha256,
    expectedSha256: spec.expectedSha256,
    verifiedBefore: true,
    uploaded,
    alreadyExists,
    verifiedAfter: true,
    remoteSha256,
    remoteBytes: remoteBytes.byteLength,
    uploadStatus,
    verifyStatus,
  };
}

function readArgValue(argv: string[], flag: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const bookArg = readArgValue(argv, "--book");
  const fileArg = readArgValue(argv, "--file");
  const result = await uploadSampleRelease({
    bookFile: bookArg ? resolveBookRegistryPath(bookArg) : undefined,
    fileOverride: fileArg,
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
