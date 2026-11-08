import type { CachePort } from "../application/ports/CachePort";
import type { QaIntelCache } from "../cache";

export class CacheAdapter implements CachePort {
  constructor(private readonly cache: QaIntelCache) {}

  async getAST(path: string): Promise<string | undefined> {
    // If the cache is async (Redis), resolve it; otherwise return direct value
    const result = this.cache.get<string>(`ast:${path}`);
    if (result instanceof Promise) {
      return await result;
    }
    return result;
  }

  async setAST(path: string, astText: string, ttlSeconds = 3600): Promise<void> {
    const result = this.cache.set(`ast:${path}`, astText, ttlSeconds);
    if (result instanceof Promise) {
      await result;
    }
  }

  async del(path: string): Promise<void> {
    const result = this.cache.del(`ast:${path}`);
    if (result instanceof Promise) {
      await result;
    }
  }
}
