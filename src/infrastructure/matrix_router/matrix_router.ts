import { expanRedis, isRedisRestConfigured } from "../redis/redis.client.ts";
import { ProviderRoute } from "../../domain/settings/settings.port.ts";
import { MatrixRouterUnavailableError } from "./matrix_router_errors.ts";
import { GLOBAL } from "../../../payments/src/settings_registry.ts";

/**
 * Legacy single-key circuit-breaker shape (`matrix:${namespace}:${id}`), still read during rollout so any
 * already-open breaker written before per-provider keys is respected. New writes use per-provider keys so
 * concurrent marks for different providers cannot drop each other.
 */
interface RouterState {
  down?: Record<string, string>;
  updated_at: string;
}

interface ProviderDownState {
  down_until: string;
  updated_at: string;
}

interface LoadDownStateResult {
  down: Record<string, string>;
  degraded: boolean;
}

interface DegradedResult {
  degraded: boolean;
}

interface NextIndexResult {
  index: number;
  degraded: boolean;
  error?: unknown;
}

const DEFAULT_DOWN_MS = GLOBAL.limits.rail_skip_ms;

export class MatrixRouter {

  private static errorName(err: unknown): string {
    if (err instanceof Error && err.name) return err.name.replace(/[\r\n]+/g, " ").trim() || "Error";
    if (err !== null && typeof err === "object" && "name" in err && typeof (err as { name?: unknown }).name === "string") {
      const name = (err as { name: string }).name.replace(/[\r\n]+/g, " ").trim();
      if (name) return name;
    }
    return "UnknownError";
  }

  private static isRedisConfigured(): boolean {
    return isRedisRestConfigured();
  }

  private static redisKey(namespace: string, id: string): string {
    return `matrix:${namespace}:${id}`;
  }

  private static providerDownKey(namespace: string, id: string, provider: string): string {
    return `matrix:${namespace}:${id}:down:${provider}`;
  }

  private static counterKey(namespace: string, id: string): string {
    return `matrix:${namespace}:${id}:counter`;
  }

  private static parseDownUntilMs(iso: unknown): number {
    if (typeof iso !== "string") throw new SyntaxError("Invalid breaker timestamp");
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) throw new SyntaxError("Invalid breaker timestamp");
    return ms;
  }

  private static async loadDownState(
    namespace: string,
    id: string,
    routes: ProviderRoute[],
    nowMs: number,
  ): Promise<LoadDownStateResult> {
    if (!this.isRedisConfigured()) return { down: {}, degraded: false };
    const providers = [...new Set(routes.map((r) => r.provider))];
    try {
      const [legacyRaw, ...providerRaws] = await Promise.all([
        expanRedis.get<string>(this.redisKey(namespace, id)),
        ...providers.map((provider) => expanRedis.get<string>(this.providerDownKey(namespace, id, provider))),
      ]);

      const down: Record<string, string> = {};
      if (legacyRaw) {
        // Valid JSON is not enough: a legacy breaker that is not an object, or whose `down` map holds a value that is not a
        // parseable timestamp, is invalid state. It throws into the degraded handler below, so no rail is re-enabled silently.
        const legacyState = JSON.parse(legacyRaw) as unknown;
        if (legacyState === null || typeof legacyState !== "object" || Array.isArray(legacyState)) {
          throw new SyntaxError("Invalid legacy breaker state");
        }
        const legacyDown = (legacyState as RouterState).down;
        if (legacyDown !== undefined) {
          if (legacyDown === null || typeof legacyDown !== "object" || Array.isArray(legacyDown)) {
            throw new SyntaxError("Invalid legacy breaker down map");
          }
          for (const [provider, iso] of Object.entries(legacyDown)) {
            const untilMs = this.parseDownUntilMs(iso);
            if (untilMs > nowMs) down[provider] = iso;
          }
        }
      }

      for (let i = 0; i < providers.length; i++) {
        const raw = providerRaws[i];
        if (!raw) continue;
        const parsed = JSON.parse(raw) as Partial<ProviderDownState>;
        if (this.parseDownUntilMs(parsed?.down_until) > nowMs) {
          down[providers[i]] = parsed.down_until!;
        }
      }

      return { down, degraded: false };
    } catch (err) {
      console.warn(`[matrix_router] routing state read failed (degraded): ${this.errorName(err)}`);
      return { down: {}, degraded: true };
    }
  }

  /**
   * Zero-based round-robin position. INCR is one atomic Redis operation, so concurrent requests each receive a distinct
   * position (no lost update). The first call maps to index 0. A Redis failure is non-fatal and falls back to index 0.
   */
  private static async nextIndex(namespace: string, id: string): Promise<NextIndexResult> {
    if (!this.isRedisConfigured()) return { index: 0, degraded: false };
    try {
      const value = await expanRedis.incr(this.counterKey(namespace, id));
      return { index: value - 1, degraded: false };
    } catch (err) {
      console.warn(`[matrix_router] routing counter increment failed (degraded): ${this.errorName(err)}`);
      return { index: 0, degraded: true, error: err };
    }
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

    const loaded = await this.loadDownState(namespace, contextId, routes, Date.now());
    if (loaded.degraded) throw new MatrixRouterUnavailableError(namespace, contextId);

    const live = this.liveRoutes(routes, loaded.down);
    if (live.length === 0) throw new MatrixRouterUnavailableError(namespace, contextId);
    // One live rail has nothing to rotate, so skip the counter round trip.
    if (live.length === 1) return live[0].provider;

    const next = await this.nextIndex(namespace, contextId);
    if (next.degraded) {
      console.error(`[matrix_router] routing fallback to first rail (degraded): ${this.errorName(next.error)}`);
    }
    return this.pickAtIndex(next.index, live);
  }

  public static async markProviderDown(namespace: string, contextId: string, provider: string, durationMs: number = DEFAULT_DOWN_MS): Promise<DegradedResult> {
    if (!this.isRedisConfigured()) return { degraded: false };
    const now = new Date();
    const safeDurationMs = Number.isFinite(durationMs) ? durationMs : DEFAULT_DOWN_MS;
    // ExpanRedisClient.set supports EX (integer seconds), not PX; keep exact ms expiry inside JSON.
    const exSeconds = safeDurationMs > 0 ? Math.max(1, Math.ceil(safeDurationMs / 1000)) : 1;
    try {
      // Built inside the try: toISOString() throws RangeError for an expiry past the Date maximum.
      const payload: ProviderDownState = {
        down_until: new Date(now.getTime() + safeDurationMs).toISOString(),
        updated_at: now.toISOString(),
      };
      await expanRedis.set(this.providerDownKey(namespace, contextId, provider), JSON.stringify(payload), exSeconds);
      return { degraded: false };
    } catch (err) {
      // Non-fatal: a transient save failure only loses breaker state.
      console.warn(`[matrix_router] routing state save failed (degraded): ${this.errorName(err)}`);
      return { degraded: true };
    }
  }
}
