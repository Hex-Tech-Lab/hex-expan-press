// Redis is injected, not imported: hex-expan has no web/lib/redis. Without a port the engine uses the in-memory cache.
export interface RedisPort {
  getRedisValue(key: string): Promise<string | null | undefined>;
  setRedisValue(key: string, raw: string, ttlSeconds: number): Promise<unknown>;
  deleteRedisKey(key: string): Promise<unknown>;
}

/** Receives each Redis failure the cache swallows. The web app can inject Sentry here; the engine runner injects nothing. */
export interface ErrorReporter {
  report(error: unknown, context: { method: "get" | "set" | "del" }): void;
}

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

// Standalone: it shares no state with InMemoryCache. Inheriting its sync get() conflicted with the async one here.
class RedisCache {
  private activeWrites = new Map<string, { raw: string | null; done: Promise<void> }>();
  constructor(
    private readonly redis: RedisPort,
    private readonly reporter?: ErrorReporter,
  ) {}
  /** Every Redis failure is logged and reported, then swallowed: the caller sees a cache miss, never an exception. */
  private report(error: unknown, method: "get" | "set" | "del") {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[redis-cache]", { message, operation: method });
    try {
      this.reporter?.report(error, { method });
    } catch (reporterError) {
      console.error("[redis-cache-reporter]", reporterError);
    }
  }
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.getRedisValue(key);
      if (raw === undefined || raw === null) return undefined;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.report(error, "get");
      return undefined;
    }
  }
  async set<T>(key: string, value: T, ttlSeconds = 3600): Promise<void> {
    let raw: string;
    try {
      // Type validation to ensure AST objects (e.g. objects containing complex project/node helpers or ts-morph methods) are not stored.
      if (value && (typeof value === "object") && ("getFilePath" in value || "getProject" in value || "forEachDescendant" in value)) {
        throw new Error("Cannot serialize AST/SourceFile objects to RedisCache backend.");
      }
      raw = JSON.stringify(value);
    } catch (error) {
      this.report(error, "set");
      return;
    }
    const serialized: string = raw;
    // The same value already in flight is shared. A different value queues after that write, so it is never dropped.
    const inFlight = this.activeWrites.get(key);
    if (inFlight && inFlight.raw === serialized) return inFlight.done;
    const previous = inFlight?.done ?? Promise.resolve();
    const done = previous
      .then(() => this.redis.setRedisValue(key, serialized, ttlSeconds))
      .then(() => undefined, (error: unknown) => this.report(error, "set"));
    // Only the entry that is still current clears the key, so a finishing earlier write cannot untrack a newer one.
    const entry = {
      raw: serialized,
      done: done.finally(() => {
        if (this.activeWrites.get(key) === entry) this.activeWrites.delete(key);
      }),
    };
    this.activeWrites.set(key, entry);
    return entry.done;
  }
  async del(key: string): Promise<void> {
    const previous = this.activeWrites.get(key)?.done ?? Promise.resolve();
    const done = previous
      .then(() => this.redis.deleteRedisKey(key))
      .then(() => undefined, (error: unknown) => this.report(error, "del"));
    const entry = {
      raw: null,
      done: done.finally(() => {
        if (this.activeWrites.get(key) === entry) this.activeWrites.delete(key);
      }),
    };
    this.activeWrites.set(key, entry);
    return entry.done;
  }
}

/** Redis is requested only with a port. Requesting it without one throws; it never falls back to memory silently. */
export function createCache(useRedis: boolean, redis?: RedisPort, reporter?: ErrorReporter) {
  if (!useRedis) return new InMemoryCache();
  if (!redis) throw new Error("createCache: Redis requested without a RedisPort");
  return new RedisCache(redis, reporter);
}

export type QaIntelCache = InMemoryCache | RedisCache;
