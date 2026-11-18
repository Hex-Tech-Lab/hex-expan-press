// Hermetic check of the REST command shapes ExpanRedisClient sends. fetch is stubbed, so no network is used and the
// lock and fence paths are verified against the exact EVAL and INCR payloads that Upstash REST receives.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExpanRedisClient } from "../redis.client.ts";

const URL_BASE = "https://example-redis.upstash.io";
const TOKEN = "test-token";

function bodyOf(call: unknown[]): unknown[] {
  return JSON.parse((call[1] as { body: string }).body) as unknown[];
}

describe("ExpanRedisClient REST commands", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () => new ExpanRedisClient(URL_BASE, TOKEN);

  it("compareAndDel sends one EVAL: the owner-checked script, 1 key, the namespaced key, and the owner value", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    await expect(client().compareAndDel("lock:sale:paddle:s1", "owner-uuid")).resolves.toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe(URL_BASE);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body[0]).toBe("EVAL");
    expect(body[1]).toBe('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end');
    expect(body[2]).toBe(1);
    expect(body[3]).toBe("expan:lock:sale:paddle:s1");
    expect(body[4]).toBe("owner-uuid");
  });

  it("incr sends INCR on the namespaced key and returns the new value", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: 3 }), { status: 200 }));
    await expect(client().incr("lock:sale:paddle:s1:fence")).resolves.toBe(3);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual(["INCR", "expan:lock:sale:paddle:s1:fence"]);
  });

  it("setnx with a TTL sends SET ... EX ... NX and maps OK to 1, nil to 0", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: "OK" }), { status: 200 }));
    await expect(client().setnx("lock:x", "owner", 300)).resolves.toBe(1);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual(["SET", "expan:lock:x", "owner", "EX", 300, "NX"]);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: null }), { status: 200 }));
    await expect(client().setnx("lock:x", "owner", 300)).resolves.toBe(0);
  });

  it("does not double-prefix a key that already carries the namespace", async () => {
    await client().get("expan:already");
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual(["GET", "expan:already"]);
  });

  it("refuses FLUSHDB and FLUSHALL before any request", async () => {
    const raw = client() as unknown as { command: (...args: string[]) => Promise<unknown> };
    await expect(raw.command("FLUSHDB")).rejects.toThrow(/strictly forbidden/);
    await expect(raw.command("flushall")).rejects.toThrow(/strictly forbidden/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a non-HTTPS endpoint before any request", async () => {
    await expect(new ExpanRedisClient("http://example.com", TOKEN).incr("k")).rejects.toThrow(/https required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
