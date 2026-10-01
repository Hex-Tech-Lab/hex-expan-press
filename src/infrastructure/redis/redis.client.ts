
/**
 * Isolated Upstash Redis client with mandatory key-namespacing.
 * GUARANTEE: Prepends "expan:" to every key.
 * Never performs FLUSHDB or un-namespaced operations.
 * Protects hex-yt-intel (which uses budget:*, ci:*, relations:*).
 */
/**
 * Redis REST credentials. Raw Upstash uses UPSTASH_REDIS_REST_*; the Vercel
 * KV / Marketplace integration injects KV_REST_API_*. Accept either so a
 * Vercel-provisioned store is never silently ignored.
 */
export function redisRestEnv(): { url: string; token: string } {
  return {
    url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").replace(/\/$/, ""),
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "",
  };
}

export function isRedisRestConfigured(): boolean {
  const { url, token } = redisRestEnv();
  return Boolean(url && token);
}

export class ExpanRedisClient {
  private url?: string;
  private token?: string;
  private readonly prefix: string = "expan:";
  private static readonly TIMEOUT_MS = 3000;

  constructor(url?: string, token?: string) {
    if (url) this.url = url.replace(/\/$/, "");
    if (token) this.token = token;
  }

  private getUrl(): string {
    return (this.url ?? redisRestEnv().url).replace(/\/$/, "");
  }

  private getToken(): string {
    return this.token ?? redisRestEnv().token;
  }

  private key(k: string): string {
    return k.startsWith(this.prefix) ? k : `${this.prefix}${k}`;
  }

  private async command<T = unknown>(...args: (string | number)[]): Promise<T> {
    // Hard safety guard against dangerous un-scoped operations FIRST
    const op = String(args[0]).toUpperCase();
    if (op === "FLUSHDB" || op === "FLUSHALL") {
      throw new Error(`ExpanRedisClient Security Error: ${op} is strictly forbidden across shared instances.`);
    }

    const url = this.getUrl();
    const token = this.getToken();

    if (!url || !token) {
      throw new Error("ExpanRedisClient: Missing UPSTASH_REDIS_REST_URL/TOKEN (or Vercel KV_REST_API_URL/TOKEN)");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ExpanRedisClient.TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Upstash Redis timeout after ${ExpanRedisClient.TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }


    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Upstash Redis error (${res.status}): ${txt}`);
    }

    const data = (await res.json()) as { result: T; error?: string };
    if (data.error) throw new Error(`Upstash Redis command error: ${data.error}`);
    return data.result;
  }

  async get<T = string>(key: string): Promise<T | null> {
    return this.command<T | null>("GET", this.key(key));
  }

  async set(key: string, value: string | number, exSeconds?: number): Promise<string> {
    if (exSeconds && exSeconds > 0) {
      return this.command<string>("SET", this.key(key), String(value), "EX", exSeconds);
    }
    return this.command<string>("SET", this.key(key), String(value));
  }

  async setnx(key: string, value: string | number, exSeconds?: number): Promise<number> {
    if (exSeconds && exSeconds > 0) {
      // SET key value EX seconds NX
      const res = await this.command<string | null>("SET", this.key(key), String(value), "EX", exSeconds, "NX");
      return res === "OK" ? 1 : 0;
    }
    return this.command<number>("SETNX", this.key(key), String(value));
  }

  async del(key: string): Promise<number> {
    return this.command<number>("DEL", this.key(key));
  }

  async exists(key: string): Promise<number> {
    return this.command<number>("EXISTS", this.key(key));
  }
}

export const expanRedis = new ExpanRedisClient();
