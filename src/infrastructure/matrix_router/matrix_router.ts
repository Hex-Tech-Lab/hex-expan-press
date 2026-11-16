import { expanRedis, isRedisRestConfigured } from "../redis/redis.client.ts";
import { ProviderRoute } from "../../domain/settings/settings.port.ts";
import { MatrixRouterUnavailableError } from "./matrix_router_errors.ts";

/**
 * Circuit-breaker state for one routing context, stored as one JSON value. It holds only the rails marked down and
 * when each comes back. The round-robin counter is a separate key (see counterKey), so routing never
 * read-modify-writes it.
 */
interface RouterState {
  down?: Record<string, string>;
  updated_at: string;
}

const DEFAULT_DOWN_MS = 15 * 60 * 1000;

export class MatrixRouter {

  private static isRedisConfigured(): boolean {
    return isRedisRestConfigured();
  }

  private static redisKey(namespace: string, id: string): string {
    return `matrix:${namespace}:${id}`;
  }

  private static counterKey(namespace: string, id: string): string {
    return `matrix:${namespace}:${id}:counter`;
  }

  private static async loadState(namespace: string, id: string): Promise<RouterState | null> {
    if (!this.isRedisConfigured()) return null;
    try {
      const raw = await expanRedis.get<string>(this.redisKey(namespace, id));
      if (!raw) return null;
      return JSON.parse(raw) as RouterState;
    } catch (err) {
      console.warn("[matrix_router] routing state read failed — falling back to default route:", err);
      return null;
    }
  }

  private static async saveState(namespace: string, id: string, state: RouterState): Promise<void> {
    if (!this.isRedisConfigured()) return;
    try {
      await expanRedis.set(this.redisKey(namespace, id), JSON.stringify(state));
    } catch (err) {
      // Non-fatal: a transient save failure only loses breaker state.
      console.warn("[matrix_router] routing state save failed:", err);
    }
  }

  /**
   * Zero-based round-robin position. INCR is one atomic Redis operation, so concurrent requests each receive a distinct
   * position (no lost update). The first call maps to index 0. A Redis failure is non-fatal and falls back to index 0.
   */
  private static async nextIndex(namespace: string, id: string): Promise<number> {
    if (!this.isRedisConfigured()) return 0;
    try {
      const value = await expanRedis.incr(this.counterKey(namespace, id));
      return value - 1;
    } catch (err) {
      console.warn("[matrix_router] routing counter increment failed — using default route:", err);
      return 0;
    }
  }

  private static activeDown(down: Record<string, string> | undefined, nowMs: number): Record<string, string> {
    if (!down) return {};
    const out: Record<string, string> = {};
    for (const [provider, iso] of Object.entries(down)) {
      if (new Date(iso).getTime() > nowMs) out[provider] = iso;
    }
    return out;
  }

  private static liveRoutes(routes: ProviderRoute[], down: Record<string, string>): ProviderRoute[] {
    return routes.filter((r) => !(r.provider in down));
  }

  private static pickAtIndex(counter: number, routes: ProviderRoute[]): string {
    let sum = 0;
    const sorted = [...routes].sort((a, b) => b.weight - a.weight);
    for (const r of sorted) sum += r.weight;
    if (sum === 0) return sorted[0]?.provider;

    let target = counter % sum;
    for (const r of sorted) {
      if (target < r.weight) return r.provider;
      target -= r.weight;
    }
    return sorted[0].provider;
  }

  /**
   * Picks the provider for this request. Throws MatrixRouterUnavailableError when every rail is marked down, so the
   * caller can answer 503. A breaker-open rail is never returned, including when it is the only rail.
   */
  public static async getNextProvider(namespace: string, contextId: string, routes: ProviderRoute[]): Promise<string> {
    if (!routes || routes.length === 0) throw new Error("MatrixRouter: No routes provided.");

    const state = await this.loadState(namespace, contextId);
    const down = this.activeDown(state?.down, Date.now());
    const live = this.liveRoutes(routes, down);
    if (live.length === 0) throw new MatrixRouterUnavailableError(namespace, contextId);
    // One live rail has nothing to rotate, so skip the counter round trip.
    if (live.length === 1) return live[0].provider;

    return this.pickAtIndex(await this.nextIndex(namespace, contextId), live);
  }

  public static async markProviderDown(namespace: string, contextId: string, provider: string, durationMs: number = DEFAULT_DOWN_MS): Promise<void> {
    const now = new Date();
    const state: RouterState = (await this.loadState(namespace, contextId)) ?? { updated_at: now.toISOString() };
    state.down = { ...(state.down ?? {}), [provider]: new Date(now.getTime() + durationMs).toISOString() };
    state.updated_at = now.toISOString();
    await this.saveState(namespace, contextId, state);
  }
}
