import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpanRedisClient } from "../../src/infrastructure/redis/redis.client.ts";

// The Redis REST client sends its token as a credential. A plaintext non-loopback URL must be refused before any request.
type Cmd = { command: (...args: (string | number)[]) => Promise<unknown> };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExpanRedisClient transport guard", () => {
  it("refuses a plaintext non-loopback URL before any request is sent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = new ExpanRedisClient("http://remote-probe.example.test", "token") as unknown as Cmd;
    await expect(client.command("GET", "k")).rejects.toThrow(/https required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows http to loopback, so a local test instance still works", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ result: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const client = new ExpanRedisClient("http://127.0.0.1:6379", "token") as unknown as Cmd;
    await client.command("GET", "k");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
