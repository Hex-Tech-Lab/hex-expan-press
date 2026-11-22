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

/** Acquires an exclusive per-cacheDir lockfile before paid VCP calls or assembly, reclaiming stale dead-PID locks once. */
export function acquireNarrationLock(cacheDir: string): NarrationLock {
  mkdirSync(cacheDir, { recursive: true });
  const lockPath = path.join(cacheDir, ".narration.lock");
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${payload}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            if (existsSync(lockPath)) unlinkSync(lockPath);
          } catch (err) {
            console.warn("[vcp] Lock cleanup warning:", err instanceof Error ? err.message : String(err));
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST") {
        throw err instanceof Error ? err : new Error(String(err));
      }

      let existingPid: number | undefined;
      let existingStartedAt: string | undefined;
      let parseable = false;
      try {
        const raw = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
        parseable = true;
        if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) existingPid = parsed.pid;
        if (typeof parsed.startedAt === "string") existingStartedAt = parsed.startedAt;
      } catch (readErr) {
        console.warn("[vcp] Unparseable narration lockfile:", readErr instanceof Error ? readErr.message : String(readErr));
      }

      if (existingPid !== undefined && isPidAlive(existingPid)) {
        throw new Error(
          `Narration lock already held at ${lockPath} by active pid=${existingPid} (startedAt=${existingStartedAt ?? "unknown"})`,
        );
      }

      if (attempt === 0) {
        if (!parseable) {
          try {
            if (Date.now() - statSync(lockPath).mtimeMs < 2000) {
              throw new Error(`Narration lock already held at ${lockPath} (concurrent initialization in progress)`);
            }
          } catch (statErr) {
            const statCode = (statErr as NodeJS.ErrnoException | null)?.code;
            console.warn("[vcp] Lock stat check:", statErr instanceof Error ? statErr.message : String(statErr));
            if (statCode !== "ENOENT") {
              throw statErr instanceof Error ? statErr : new Error(String(statErr));
            }
            continue;
          }
        }
        console.warn(`[vcp] Reclaiming stale narration lock at ${lockPath} (pid=${existingPid ?? "unknown"})`);
        try {
          unlinkSync(lockPath);
        } catch (unlinkErr) {
          const unlinkCode = (unlinkErr as NodeJS.ErrnoException | null)?.code;
          console.warn("[vcp] Stale lock unlink:", unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
          if (unlinkCode !== "ENOENT") {
            throw unlinkErr instanceof Error ? unlinkErr : new Error(String(unlinkErr));
          }
        }
        continue;
      }

      throw new Error(
        `Narration lock already held at ${lockPath} (pid=${existingPid ?? "unknown"}, startedAt=${existingStartedAt ?? "unknown"})`,
      );
    }
  }
  throw new Error(`Failed to acquire narration lock at ${lockPath}`);
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
