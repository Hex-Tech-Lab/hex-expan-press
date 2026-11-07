import { createHash } from "node:crypto";
import { expanRedis, type ExpanRedisClient } from "../../../../src/infrastructure/redis/redis.client";
import type { SweepCursor, SweepHealth, SweepRecord, SweepStorePort } from "./core";

// Redis-backed store. expanRedis prefixes every key with "expan:". Records are keyed by a SHA-256 of the dedupe key,
// so a long Message-ID never reaches the key space. A missing or unreachable Redis throws (loud), never returns empty.

const PREFIX = "billing-sweep:";
const CURSOR_KEY = `${PREFIX}cursor`;
const HEALTH_KEY = `${PREFIX}health`;
const recordKeyFor = (key: string): string => `${PREFIX}rec:${createHash("sha256").update(key).digest("hex")}`;

function parseCursor(raw: string): SweepCursor {
  const parsed = JSON.parse(raw) as Partial<SweepCursor>;
  if (typeof parsed.uidValidity !== "string" || !Number.isSafeInteger(parsed.lastUid) || (parsed.lastUid ?? -1) < 0) {
    throw new Error("billing sweep cursor is malformed");
  }
  return { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid as number };
}

function parseHealth(raw: string): SweepHealth {
  const parsed = JSON.parse(raw) as Partial<SweepHealth>;
  if ((parsed.status !== "ok" && parsed.status !== "failed") || typeof parsed.at !== "string") {
    throw new Error("billing sweep health record is malformed");
  }
  return {
    status: parsed.status,
    at: parsed.at,
    lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
  };
}

export function createRedisSweepStore(redis: ExpanRedisClient = expanRedis): SweepStorePort {
  return {
    async getCursor() {
      const raw = await redis.get<string>(CURSOR_KEY);
      return raw === null ? null : parseCursor(raw);
    },
    async setCursor(cursor) {
      await redis.set(CURSOR_KEY, JSON.stringify(cursor));
    },
    async recordIfNew(record: SweepRecord) {
      const written = await redis.setnx(recordKeyFor(record.key), JSON.stringify(record));
      return written === 1;
    },
    async getHealth() {
      const raw = await redis.get<string>(HEALTH_KEY);
      return raw === null ? null : parseHealth(raw);
    },
    async setHealth(health) {
      await redis.set(HEALTH_KEY, JSON.stringify(health));
    },
  };
}
