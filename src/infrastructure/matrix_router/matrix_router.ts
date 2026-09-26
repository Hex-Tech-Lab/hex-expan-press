import { expanRedis } from "../redis/redis.client.ts";
import { ProviderRoute } from "../../domain/settings/settings.port.ts";

interface RouterState {
  counter: number;
  updated_at: string;
  down?: Record<string, string>;
}

const DEFAULT_DOWN_MS = 15 * 60 * 1000;

export class MatrixRouter {
  
  private static isRedisConfigured(): boolean {
    return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  }

  private static redisKey(namespace: string, id: string): string {
    return `matrix:${namespace}:${id}`;
  }

  private static async loadState(namespace: string, id: string): Promise<RouterState | null> {
    if (!this.isRedisConfigured()) return null;
    try {
      const raw = await expanRedis.get<string>(this.redisKey(namespace, id));
      if (!raw) return null;
      return JSON.parse(raw) as RouterState;
    } catch {
      return null;
    }
  }

  private static async saveState(namespace: string, id: string, state: RouterState): Promise<void> {
    if (!this.isRedisConfigured()) return;
    try {
      await expanRedis.set(this.redisKey(namespace, id), JSON.stringify(state));
    } catch {
      // ignore silently on save failure if it's a transient network issue
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
    const live = routes.filter((r) => !(r.provider in down));
    if (live.length === 0) throw new Error("MatrixRouter: every rail is marked down"); return live;
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

  public static async getNextProvider(namespace: string, contextId: string, routes: ProviderRoute[]): Promise<string> {
    if (!routes || routes.length === 0) throw new Error("MatrixRouter: No routes provided.");
    if (routes.length === 1) return routes[0].provider; 

    const now = new Date();
    const state = (await this.loadState(namespace, contextId)) ?? { counter: 0, updated_at: now.toISOString() };
    const down = this.activeDown(state.down, now.getTime());
    
    const live = this.liveRoutes(routes, down);
    const pick = this.pickAtIndex(state.counter, live);

    await this.saveState(namespace, contextId, {
      counter: state.counter + 1,
      updated_at: now.toISOString(),
      ...(Object.keys(down).length > 0 ? { down } : {})
    });

    return pick;
  }

  public static async markProviderDown(namespace: string, contextId: string, provider: string, durationMs: number = DEFAULT_DOWN_MS): Promise<void> {
    const now = new Date();
    const state = (await this.loadState(namespace, contextId)) ?? { counter: 0, updated_at: now.toISOString() };
    state.down = { ...(state.down ?? {}), [provider]: new Date(now.getTime() + durationMs).toISOString() };
    state.updated_at = now.toISOString();
    await this.saveState(namespace, contextId, state);
  }
}
