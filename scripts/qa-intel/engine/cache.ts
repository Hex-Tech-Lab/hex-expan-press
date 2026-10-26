// Redis is injected, not imported: hex-expan has no web/lib/redis. Without a port the engine uses the in-memory cache.
export interface RedisPort {
  getRedisValue(key: string): Promise<string | null | undefined>;
  setRedisValue(key: string, raw: string, ttlSeconds: number): Promise<unknown>;
  deleteRedisKey(key: string): Promise<unknown>;
}
import type { SourceFile } from "ts-morph";

interface CacheItem<T> {
  value: T;
  expiresAt: number;
}

class InMemoryCache {
  private store = new Map<string, CacheItem<unknown>>();
  get<T>(key: string): T | undefined {
    const item = this.store.get(key) as CacheItem<T> | undefined;
    if (!item) return undefined;
    if (item.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return item.value;
  }
  set<T>(key: string, value: T, ttlSeconds = 3600): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  del(key: string) {
    this.store.delete(key);
  }
}

class RedisCache extends InMemoryCache {
  private activeWrites = new Map<string, Promise<void>>();
  constructor(private readonly redis: RedisPort) {
    super();
  }
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.getRedisValue(key);
      if (raw === undefined || raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[redis-cache]', { message, operation: 'get' });
      try {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureException(e, { contexts: { operation: 'redis-cache', method: 'get' } });
      } catch (sentryErr) {
        console.error('[redis-cache-sentry]', sentryErr);
      }
      return undefined;
    }
  }
  async set<T>(key: string, value: T, ttlSeconds = 3600): Promise<void> {
    if (this.activeWrites.has(key)) {
      return this.activeWrites.get(key);
    }
    const writePromise = (async () => {
      try {
        // Type validation to ensure AST objects (e.g. objects containing complex project/node helpers or ts-morph methods) are not stored.
        if (value && (typeof value === "object") && ("getFilePath" in value || "getProject" in value || "forEachDescendant" in value)) {
          throw new Error("Cannot serialize AST/SourceFile objects to RedisCache backend.");
        }
        const raw = JSON.stringify(value);
        await this.redis.setRedisValue(key, raw, ttlSeconds);
      } catch (e: any) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[redis-cache]', { message, operation: 'set' });
        try {
          const Sentry = await import("@sentry/nextjs");
          Sentry.captureException(e, { contexts: { operation: 'redis-cache', method: 'set' } });
        } catch (sentryErr) {
          console.error('[redis-cache-sentry]', sentryErr);
        }
      } finally {
        this.activeWrites.delete(key);
      }
    })();
    this.activeWrites.set(key, writePromise);
    return writePromise;
  }
  async del(key: string) {
    try {
      await this.redis.deleteRedisKey(key);
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[redis-cache]', { message, operation: 'del' });
      try {
        const Sentry = await import("@sentry/nextjs");
        Sentry.captureException(e, { contexts: { operation: 'redis-cache', method: 'del' } });
      } catch (sentryErr) {
        console.error('[redis-cache-sentry]', sentryErr);
      }
    }
  }
}

export function createCache(useRedis: boolean, redis?: RedisPort) {
  return useRedis && redis ? new RedisCache(redis) : new InMemoryCache();
}

export type QaIntelCache = InMemoryCache | RedisCache;