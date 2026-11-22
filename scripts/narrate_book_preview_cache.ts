import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const MIN_WAV_HEADER_BYTES = 44;
export const MAX_AUDIO_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export async function fetchGetWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error(`fetchGetWithRetry only permits GET/HEAD, got ${method}`);
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { ...init, method, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await res.body?.cancel().catch((cancelErr: unknown) => {
          console.warn(
            "[vcp] retry response body cancel warning:",
            cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
          );
        });
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * (attempt + 1), 10000)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      console.warn(`[vcp] GET attempt ${attempt + 1}/6 failed:`, err instanceof Error ? err.message : String(err));
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * (attempt + 1), 10000)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function readBoundedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  const rawLen = res.headers.get("content-length");
  if (rawLen) {
    const parsedLen = Number.parseInt(rawLen, 10);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      throw new Error(`Audio response exceeds cap (${parsedLen} > ${maxBytes})`);
    }
  }
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("Audio response has no readable body stream");
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Audio stream exceeded ${maxBytes} byte cap`);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, total);
}

export interface NarrationLock {
  lockPath: string;
  release: () => void;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    console.warn("[vcp] pid liveness probe result:", code ?? (err instanceof Error ? err.message : String(err)));
    return code === "EPERM";
  }
}

/** Validates that a cached WAV file exists, has at least a 44-byte header, and starts with RIFF/WAVE magic bytes. */
export function isValidWavFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let fd: number | undefined;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_WAV_HEADER_BYTES) return false;
    const header = Buffer.alloc(12);
    fd = openSync(filePath, "r");
    const bytesRead = readSync(fd, header, 0, 12, 0);
    if (bytesRead < 12) return false;
    return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE";
  } catch (err) {
    console.warn("[vcp] WAV validation failed:", err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (closeErr) {
        console.warn("[vcp] WAV fd close warning:", closeErr instanceof Error ? closeErr.message : String(closeErr));
      }
    }
  }
}

function readLockMetadata(lockPath: string): {
  pid?: number;
  token?: string;
  startedAt?: string;
  parseable: boolean;
  ino: number;
  mtimeMs: number;
} {
  const stat = statSync(lockPath);
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown; startedAt?: unknown };
    return {
      pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      parseable: true,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  } catch (readErr) {
    console.warn("[vcp] Unparseable narration lockfile:", readErr instanceof Error ? readErr.message : String(readErr));
    return { parseable: false, ino: stat.ino, mtimeMs: stat.mtimeMs };
  }
}

function buildLockHandle(lockPath: string, ownerToken: string): NarrationLock {
  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (!existsSync(lockPath)) return;
        const raw = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { token?: unknown };
        if (parsed.token !== ownerToken) return;
        unlinkSync(lockPath);
      } catch (err) {
        console.warn("[vcp] Lock cleanup warning:", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function writeExclusiveLock(lockPath: string, ownerToken: string): NarrationLock {
  const payload = JSON.stringify({ pid: process.pid, token: ownerToken, startedAt: new Date().toISOString() });
  const fd = openSync(lockPath, "wx");
  try {
    writeFileSync(fd, `${payload}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  return buildLockHandle(lockPath, ownerToken);
}

/** Acquires an exclusive per-cacheDir lockfile before paid VCP calls or assembly, using a mutex to reclaim dead-PID locks safely. */
export function acquireNarrationLock(cacheDir: string): NarrationLock {
  mkdirSync(cacheDir, { recursive: true });
  const lockPath = path.join(cacheDir, ".narration.lock");
  const reclaimPath = `${lockPath}.reclaim`;
  const ownerToken = randomUUID();

  try {
    return writeExclusiveLock(lockPath, ownerToken);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "EEXIST") {
      console.warn("[vcp] Lock acquisition failed:", err instanceof Error ? err.message : String(err));
      throw err instanceof Error ? err : new Error(String(err));
    }

    let snapshot: ReturnType<typeof readLockMetadata>;
    try {
      snapshot = readLockMetadata(lockPath);
    } catch (statErr) {
      const statCode = (statErr as NodeJS.ErrnoException | null)?.code;
      console.warn("[vcp] Lock snapshot read:", statErr instanceof Error ? statErr.message : String(statErr));
      if (statCode === "ENOENT") {
        return writeExclusiveLock(lockPath, ownerToken);
      }
      throw statErr instanceof Error ? statErr : new Error(String(statErr));
    }

    if (snapshot.pid !== undefined && isPidAlive(snapshot.pid)) {
      throw new Error(
        `Narration lock already held at ${lockPath} by active pid=${snapshot.pid} (startedAt=${snapshot.startedAt ?? "unknown"})`,
      );
    }
    if (!snapshot.parseable && Date.now() - snapshot.mtimeMs < 2000) {
      throw new Error(`Narration lock already held at ${lockPath} (concurrent initialization in progress)`);
    }

    let reclaimFd: number;
    try {
      reclaimFd = openSync(reclaimPath, "wx");
    } catch (reclaimErr) {
      const reclaimCode = (reclaimErr as NodeJS.ErrnoException | null)?.code;
      console.warn("[vcp] Reclaim mutex contention:", reclaimErr instanceof Error ? reclaimErr.message : String(reclaimErr));
      if (reclaimCode === "EEXIST") {
        throw new Error(`Narration lock reclamation already in progress at ${lockPath}`);
      }
      throw reclaimErr instanceof Error ? reclaimErr : new Error(String(reclaimErr));
    }

    try {
      let current: ReturnType<typeof readLockMetadata>;
      try {
        current = readLockMetadata(lockPath);
      } catch (recheckErr) {
        const recheckCode = (recheckErr as NodeJS.ErrnoException | null)?.code;
        console.warn("[vcp] Lock recheck:", recheckErr instanceof Error ? recheckErr.message : String(recheckErr));
        if (recheckCode === "ENOENT") {
          return writeExclusiveLock(lockPath, ownerToken);
        }
        throw recheckErr instanceof Error ? recheckErr : new Error(String(recheckErr));
      }

      if (current.pid !== undefined && isPidAlive(current.pid)) {
        throw new Error(
          `Narration lock already held at ${lockPath} by active pid=${current.pid} (startedAt=${current.startedAt ?? "unknown"})`,
        );
      }
      if (current.token !== snapshot.token || current.ino !== snapshot.ino) {
        throw new Error(`Narration lock at ${lockPath} changed owner during reclamation; refusing reclaim`);
      }

      console.warn(`[vcp] Reclaiming stale narration lock at ${lockPath} (pid=${current.pid ?? "unknown"})`);
      unlinkSync(lockPath);
      return writeExclusiveLock(lockPath, ownerToken);
    } finally {
      try {
        closeSync(reclaimFd);
      } catch (closeErr) {
        console.warn("[vcp] Reclaim fd close warning:", closeErr instanceof Error ? closeErr.message : String(closeErr));
      }
      try {
        if (existsSync(reclaimPath)) unlinkSync(reclaimPath);
      } catch (unlinkErr) {
        console.warn("[vcp] Reclaim lock cleanup warning:", unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
      }
    }
  }
}

/** Deduplicates pending chunks by their WAV cache path so identical spoken chunks are never double-synthesized. */
export function dedupeChunksByCachePath<T>(chunks: ReadonlyArray<T>, getCachePath: (chunk: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const chunk of chunks) {
    const cachePath = getCachePath(chunk);
    if (seen.has(cachePath)) continue;
    seen.add(cachePath);
    unique.push(chunk);
  }
  return unique;
}

/** Atomically writes downloaded audio bytes to outPath via a PID-scoped temp file and rename. */
export function writeAudioBytesAtomically(outPath: string, bytes: Buffer): void {
  const tmpPath = `${outPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, outPath);
  } catch (writeErr) {
    console.warn("[vcp] Atomic audio write failed:", writeErr instanceof Error ? writeErr.message : String(writeErr));
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupErr) {
      console.warn("[vcp] Temp audio cleanup failed:", cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
    }
    throw writeErr instanceof Error ? writeErr : new Error(String(writeErr));
  }
}
