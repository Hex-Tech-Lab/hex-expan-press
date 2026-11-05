import { describe, expect, it } from "vitest";
import {
  contentKey,
  isDeliverable,
  newRecord,
  reconcileObject,
  replicateObject,
  sha256Hex,
  type ObjectCopyPort,
  type ReplicaManifestStore,
  type ReplicaRecord,
} from "../replica-manifest";

const enc = (s: string) => new TextEncoder().encode(s);

class MemoryCopy implements ObjectCopyPort {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;
  failPut = false;
  /** When set, get returns these bytes instead of what was stored (simulates a mismatched read-back). */
  corruptGet: Uint8Array | null = null;

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.puts += 1;
    if (this.failPut) throw new Error("put failed");
    this.objects.set(key, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    if (this.corruptGet) return this.corruptGet;
    return this.objects.get(key) ?? null;
  }
}

class MemoryManifest implements ReplicaManifestStore {
  readonly rows = new Map<string, ReplicaRecord>();
  async get(key: string): Promise<ReplicaRecord | null> {
    const r = this.rows.get(key);
    return r ? structuredClone(r) : null;
  }
  async save(record: ReplicaRecord): Promise<void> {
    this.rows.set(record.key, structuredClone(record));
  }
}

const BYTES = enc("ebook release v1");
const SHA = sha256Hex(BYTES);
const KEY = contentKey("release-files", SHA, "pdf");

describe("contentKey", () => {
  it("binds the key to the sha256", () => {
    expect(KEY).toBe(`release-files/${SHA}.pdf`);
  });
  it("rejects a malformed hash", () => {
    expect(() => contentKey("release-files", "abc", "pdf")).toThrow(/sha256/);
  });
  it("rejects an unsafe prefix or extension", () => {
    expect(() => contentKey("../etc", SHA, "pdf")).toThrow(/prefix/);
    expect(() => contentKey("release-files", SHA, "pd/f")).toThrow(/extension/);
  });
});

describe("replicateObject", () => {
  it("verifies both copies and marks the object deliverable", async () => {
    const primary = new MemoryCopy();
    const secondary = new MemoryCopy();
    const manifest = new MemoryManifest();
    const rec = await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest });
    expect(rec.copies).toEqual({ primary: "verified", secondary: "verified" });
    expect(isDeliverable(rec)).toBe(true);
  });

  it("keeps the object deliverable when the primary write fails and the secondary verifies", async () => {
    const primary = new MemoryCopy();
    primary.failPut = true;
    const secondary = new MemoryCopy();
    const rec = await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest: new MemoryManifest() });
    expect(rec.copies).toEqual({ primary: "failed", secondary: "verified" });
    expect(isDeliverable(rec)).toBe(true);
  });

  it("does not report a copy verified when the read-back hash differs", async () => {
    const primary = new MemoryCopy();
    primary.corruptGet = enc("some other bytes");
    const secondary = new MemoryCopy();
    const rec = await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest: new MemoryManifest() });
    expect(rec.copies.primary).toBe("failed");
    expect(rec.copies.secondary).toBe("verified");
  });

  it("is not deliverable when neither copy verifies", async () => {
    const primary = new MemoryCopy();
    primary.failPut = true;
    const secondary = new MemoryCopy();
    secondary.failPut = true;
    const rec = await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest: new MemoryManifest() });
    expect(isDeliverable(rec)).toBe(false);
  });

  it("does not rewrite a copy already verified on a re-run", async () => {
    const primary = new MemoryCopy();
    const secondary = new MemoryCopy();
    const manifest = new MemoryManifest();
    await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest });
    await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest });
    expect(primary.puts).toBe(1);
    expect(secondary.puts).toBe(1);
  });

  it("refuses to reuse a key whose recorded hash differs from the bytes", async () => {
    const manifest = new MemoryManifest();
    await manifest.save({ key: KEY, sha256: "f".repeat(64), copies: { primary: "verified", secondary: "verified" } });
    await expect(
      replicateObject({ key: KEY, bytes: BYTES, primary: new MemoryCopy(), secondary: new MemoryCopy(), manifest }),
    ).rejects.toThrow(/manifest conflict/);
  });

  it("refuses a key that does not contain the bytes' hash", async () => {
    await expect(
      replicateObject({
        key: "release-files/not-the-hash.pdf",
        bytes: BYTES,
        primary: new MemoryCopy(),
        secondary: new MemoryCopy(),
        manifest: new MemoryManifest(),
      }),
    ).rejects.toThrow(/content-addressed/);
  });
});

describe("reconcileObject", () => {
  it("repairs a failed copy from the verified copy", async () => {
    const primary = new MemoryCopy();
    primary.failPut = true;
    const secondary = new MemoryCopy();
    const manifest = new MemoryManifest();
    const rec = await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest });
    expect(rec.copies.primary).toBe("failed");

    primary.failPut = false;
    const repaired = await reconcileObject({ record: rec, primary, secondary, manifest });
    expect(repaired.copies).toEqual({ primary: "verified", secondary: "verified" });
    expect(primary.objects.get(KEY)).toEqual(BYTES);
  });

  it("changes nothing when no copy is verified", async () => {
    const record = newRecord(KEY, SHA);
    const rec = await reconcileObject({
      record,
      primary: new MemoryCopy(),
      secondary: new MemoryCopy(),
      manifest: new MemoryManifest(),
    });
    expect(isDeliverable(rec)).toBe(false);
    expect(rec.copies).toEqual({ primary: "pending", secondary: "pending" });
  });

  it("demotes a verified source whose bytes no longer match, and does not copy them", async () => {
    const primary = new MemoryCopy();
    const secondary = new MemoryCopy();
    const manifest = new MemoryManifest();
    const rec = await replicateObject({ key: KEY, bytes: BYTES, primary, secondary, manifest });
    // Simulate the primary object being silently replaced after verification.
    primary.objects.set(KEY, enc("tampered"));
    const repaired = await reconcileObject({ record: rec, primary, secondary, manifest });
    expect(repaired.copies.primary).toBe("failed");
    expect(repaired.copies.secondary).toBe("verified");
  });
});
