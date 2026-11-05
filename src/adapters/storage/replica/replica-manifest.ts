import { createHash } from "node:crypto";

/**
 * Storage factory core (ADR 0065). Provider-neutral: no SDK, no network.
 *
 * Identity is the SHA-256 of the bytes. ETags are provider-specific and are never
 * compared across providers. Keys are content-addressed and write-once.
 */

export const COPY_NAMES = ["primary", "secondary"] as const;
export type CopyName = (typeof COPY_NAMES)[number];

/** verified: read back and SHA-256 matched. failed: last attempt did not verify. pending: never attempted. */
export type CopyState = "pending" | "verified" | "failed";

export interface ReplicaRecord {
  key: string;
  sha256: string;
  copies: Record<CopyName, CopyState>;
}

/** One provider. put must be idempotent for identical bytes. get reads the stored object back for verification. */
export interface ObjectCopyPort {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export interface ReplicaManifestStore {
  get(key: string): Promise<ReplicaRecord | null>;
  save(record: ReplicaRecord): Promise<void>;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_PREFIX = /^[a-z0-9][a-z0-9/-]{0,119}$/;
const SAFE_EXT = /^[a-z0-9]{1,8}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Builds prefix/<sha256>.<ext>. The hash in the key means an overwrite cannot replace a sold file. */
export function contentKey(prefix: string, sha256: string, ext: string): string {
  if (!SAFE_PREFIX.test(prefix)) throw new Error(`unsafe prefix: ${prefix}`);
  if (!SHA256_HEX.test(sha256)) throw new Error("sha256 must be 64 lowercase hex characters");
  if (!SAFE_EXT.test(ext)) throw new Error(`unsafe extension: ${ext}`);
  return `${prefix}/${sha256}.${ext}`;
}

export function newRecord(key: string, sha256: string): ReplicaRecord {
  return { key, sha256, copies: { primary: "pending", secondary: "pending" } };
}

/** Deliverable when at least one copy is verified against the manifest hash. */
export function isDeliverable(record: ReplicaRecord): boolean {
  return COPY_NAMES.some((copy) => record.copies[copy] === "verified");
}

function assertKeyBindsHash(key: string, sha256: string): void {
  if (!key.includes(sha256)) throw new Error(`key ${key} does not contain its sha256; keys must be content-addressed`);
}

/**
 * Writes one copy and verifies it by reading it back. Returns the new state.
 * A thrown put or a mismatched read-back is recorded as failed; it never reports verified.
 */
async function writeAndVerify(
  copy: ObjectCopyPort,
  key: string,
  bytes: Uint8Array,
  sha256: string,
): Promise<CopyState> {
  try {
    await copy.put(key, bytes);
    const stored = await copy.get(key);
    if (stored === null) return "failed";
    return sha256Hex(stored) === sha256 ? "verified" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Primary-then-secondary write. Each copy is verified before the manifest says so.
 * Copies already verified are not rewritten, so re-running is safe.
 */
export async function replicateObject(args: {
  key: string;
  bytes: Uint8Array;
  primary: ObjectCopyPort;
  secondary: ObjectCopyPort;
  manifest: ReplicaManifestStore;
}): Promise<ReplicaRecord> {
  const sha256 = sha256Hex(args.bytes);
  assertKeyBindsHash(args.key, sha256);

  const record = (await args.manifest.get(args.key)) ?? newRecord(args.key, sha256);
  if (record.sha256 !== sha256) {
    throw new Error(`manifest conflict for ${args.key}: recorded hash differs from these bytes`);
  }

  const ports: Record<CopyName, ObjectCopyPort> = { primary: args.primary, secondary: args.secondary };
  for (const copy of COPY_NAMES) {
    if (record.copies[copy] === "verified") continue;
    record.copies[copy] = await writeAndVerify(ports[copy], args.key, args.bytes, sha256);
    await args.manifest.save(record);
  }
  return record;
}

/**
 * Repairs any copy that is not verified, using a verified copy as the source.
 * With no verified copy the record is returned unchanged and is not deliverable.
 */
export async function reconcileObject(args: {
  record: ReplicaRecord;
  primary: ObjectCopyPort;
  secondary: ObjectCopyPort;
  manifest: ReplicaManifestStore;
}): Promise<ReplicaRecord> {
  const { record } = args;
  const ports: Record<CopyName, ObjectCopyPort> = { primary: args.primary, secondary: args.secondary };
  const source = COPY_NAMES.find((copy) => record.copies[copy] === "verified");
  if (!source) return record;

  let bytes: Uint8Array | null = null;
  try {
    bytes = await ports[source].get(record.key);
  } catch {
    bytes = null;
  }
  if (bytes === null || sha256Hex(bytes) !== record.sha256) {
    // The source copy no longer matches the manifest. Demote it so it is never served as verified.
    record.copies[source] = "failed";
    await args.manifest.save(record);
    return record;
  }

  for (const copy of COPY_NAMES) {
    if (record.copies[copy] === "verified") continue;
    record.copies[copy] = await writeAndVerify(ports[copy], record.key, bytes, record.sha256);
    await args.manifest.save(record);
  }
  return record;
}
