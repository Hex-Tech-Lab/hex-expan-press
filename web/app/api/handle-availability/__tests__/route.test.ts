import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The route must use the publishable key only. A secret key on a public route is the failure this guards.
const clientState = vi.hoisted(() => ({
  rpcResult: { data: true as unknown, error: null as unknown },
  rpcThrows: false,
  calls: [] as { url: string; key: string }[],
  rpcArgs: [] as { name: string; args: unknown }[],
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string) => {
    clientState.calls.push({ url, key });
    return {
      rpc: async (name: string, args: unknown) => {
        clientState.rpcArgs.push({ name, args });
        if (clientState.rpcThrows) throw new Error("socket hang up");
        return clientState.rpcResult;
      },
    };
  },
}));

const limiter = vi.hoisted(() => ({
  ips: [] as string[],
  decide: async (ip: string): Promise<unknown> => {
    limiter.ips.push(ip);
    return { kind: "allowed" };
  },
}));
vi.mock("../../../../src/lib/handle_ratelimit", () => ({
  checkHandleRateLimit: (ip: string) => limiter.decide(ip),
}));

const sentry = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => {
    sentry.calls.push(args);
  },
}));

import { GET } from "../route";

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/handle-availability${query}`);
}

function sentryText(): string {
  return sentry.calls
    .map(([err]) => {
      const reported = err as Error;
      return `${reported?.message ?? ""}\n${reported?.stack ?? ""}`;
    })
    .join("\n");
}

beforeEach(() => {
  clientState.rpcResult = { data: true, error: null };
  clientState.rpcThrows = false;
  clientState.calls = [];
  clientState.rpcArgs = [];
  sentry.calls = [];
  vi.stubEnv("SUPABASE_URL", "https://project.example.test");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "pub-key-for-tests");
  vi.stubEnv("SUPABASE_SECRET_KEY", "secret-key-must-not-be-used");
  limiter.ips = [];
  limiter.decide = async (ip: string) => {
    limiter.ips.push(ip);
    return { kind: "allowed" };
  };
});

describe("GET /api/handle-availability: input", () => {
  it.each([
    ["", "missing handle"],
    ["?handle=a", "one character"],
    ["?handle=Kelly", "uppercase"],
    ["?handle=kelly.b", "period"],
  ])("400 for %s (%s), with a reason and no-store, and no lookup", async (query) => {
    const res = await GET(req(query));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).not.toHaveProperty("available");
    expect(typeof body.error).toBe("string");
    expect(clientState.rpcArgs).toEqual([]);
  });
});

describe("GET /api/handle-availability: answers", () => {
  it("available: true when no creator holds the handle, via the public check function", async () => {
    clientState.rpcResult = { data: true, error: null };
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true, handle: "kelly" });
    expect(clientState.rpcArgs).toEqual([{ name: "handle_available", args: { p_handle: "kelly" } }]);
  });

  it("available: false when a creator holds the handle, with no creator data in the body", async () => {
    clientState.rpcResult = { data: false, error: null };
    const res = await GET(req("?handle=kelly"));
    const body = await res.json();
    expect(body).toEqual({ available: false, handle: "kelly" });
    expect(Object.keys(body).sort()).toEqual(["available", "handle"]);
  });

  it("sends Cache-Control: no-store", async () => {
    const res = await GET(req("?handle=kelly"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/handle-availability: keys", () => {
  it("uses the publishable key, never the secret key", async () => {
    await GET(req("?handle=kelly"));
    expect(clientState.calls.length).toBeGreaterThan(0);
    for (const call of clientState.calls) {
      expect(call.key).toBe("pub-key-for-tests");
      expect(call.key).not.toBe("secret-key-must-not-be-used");
    }
  });
});

describe("GET /api/handle-availability: fails closed", () => {
  it("503 when the check errors, never answering available, and the body carries no error text", async () => {
    clientState.rpcResult = { data: null, error: { message: "relation secret_internal_name does not exist", code: "42883" } };
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Handle check unavailable" });
    expect(text).not.toMatch(/secret_internal_name/);
  });

  it("503 when the check returns neither true nor false (never treated as free)", async () => {
    clientState.rpcResult = { data: null, error: null };
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Handle check unavailable" });
  });

  it("503 when the call throws", async () => {
    clientState.rpcThrows = true;
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(503);
  });

  it("reports the failure to Sentry by class only (code), never the raw message", async () => {
    clientState.rpcResult = { data: null, error: { message: "relation secret_internal_name does not exist", code: "42883" } };
    await GET(req("?handle=kelly"));
    expect(sentry.calls.length).toBe(1);
    expect(sentryText()).toMatch(/42883/);
    expect(sentryText()).not.toMatch(/secret_internal_name/);
  });

  it("503 when the thrown error is a socket hang-up, without its message in Sentry", async () => {
    clientState.rpcThrows = true;
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(503);
    expect(sentryText()).not.toMatch(/socket hang up/);
  });
});

describe("GET /api/handle-availability: config and contract", () => {
  it("503 with the publishable key unset: no client is built, the secret key is never used, Sentry tags config", async () => {
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Handle check unavailable" });
    expect(clientState.calls).toEqual([]);
    expect(sentry.calls.length).toBe(1);
    expect((sentry.calls[0][1] as { tags: { stage: string } }).tags.stage).toBe("config");
  });

  it.each([["true"], [1], [{}]])("503 for a non-boolean check result (%j), never available", async (value) => {
    clientState.rpcResult = { data: value, error: null };
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Handle check unavailable" });
  });

  it("passes the forwarded client IP to the rate limiter, not a constant key", async () => {
    const forwarded = new NextRequest("http://localhost/api/handle-availability?handle=kelly", {
      headers: { "x-real-ip": "203.0.113.7" },
    });
    await GET(forwarded);
    expect(limiter.ips).toEqual(["203.0.113.7"]);
  });

  it("429 and 503 responses carry Cache-Control no-store", async () => {
    limiter.decide = async () => ({ kind: "limited", retryAfterSeconds: 3 });
    const limited = await GET(req("?handle=kelly"));
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    limiter.decide = async () => ({ kind: "unavailable" });
    const down = await GET(req("?handle=kelly"));
    expect(down.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/handle-availability: rate limit", () => {
  it("429 with Retry-After when throttled, and no lookup", async () => {
    limiter.decide = async () => ({ kind: "limited", retryAfterSeconds: 42 });
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(clientState.rpcArgs).toEqual([]);
  });

  it("503 when the limiter is unavailable, never answering available", async () => {
    limiter.decide = async () => ({ kind: "unavailable" });
    const res = await GET(req("?handle=kelly"));
    expect(res.status).toBe(503);
    expect(clientState.rpcArgs).toEqual([]);
  });

  it("runs the rate check before validation", async () => {
    limiter.decide = async () => ({ kind: "limited", retryAfterSeconds: 5 });
    const res = await GET(req("?handle=BAD"));
    expect(res.status).toBe(429);
  });
});
