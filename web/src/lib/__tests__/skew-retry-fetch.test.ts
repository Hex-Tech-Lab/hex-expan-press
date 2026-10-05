import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkewRetryFetch } from "../skew-retry-fetch";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFetch(responses: Response[]) {
  const fn = vi.fn(async () => responses.shift() as Response);
  return fn;
}

describe("createSkewRetryFetch", () => {
  it("retries once on 401 PGRST303 and returns the retry 200", async () => {
    const sleep = vi.fn(async () => {});
    const rows = [{ id: 1 }];
    const base = makeFetch([jsonRes(401, { code: "PGRST303", message: "JWT issued at future" }), jsonRes(200, rows)]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
    expect(base).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(350);
  });

  it("retries once on 401 'JWT issued at future' message without code", async () => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([jsonRes(401, { message: "JWT issued at future" }), jsonRes(200, [])]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x");
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("does not loop: skew 401 twice returns the second 401 after exactly 2 calls", async () => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([
      jsonRes(401, { code: "PGRST303", message: "JWT issued at future" }),
      jsonRes(401, { code: "PGRST303", message: "JWT issued at future" }),
    ]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x");
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry 401 PGRST301 (expired)", async () => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([jsonRes(401, { code: "PGRST301", message: "JWT expired" })]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x");
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry 403, 500, or non-JSON 401", async () => {
    const sleep = vi.fn(async () => {});
    for (const res of [
      new Response("forbidden", { status: 403 }),
      new Response("boom", { status: 500 }),
      new Response("not json", { status: 401, headers: { "content-type": "text/plain" } }),
    ]) {
      const base = makeFetch([res]);
      const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
      const out = await fetcher("https://db.example/rest/v1/x");
      expect(out.status).toBe(res.status);
      expect(base).toHaveBeenCalledTimes(1);
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry when init.body is a ReadableStream", async () => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([jsonRes(401, { code: "PGRST303", message: "JWT issued at future" })]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } });
    const res = await fetcher("https://db.example/rest/v1/x", { method: "POST", body: stream });
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // ---- Sprint-13 idempotency gate (ADR-0059): mutations are NEVER retried ----

  it.each(["POST", "PATCH", "PUT", "DELETE"])("does NOT retry a skew 401 on %s (mutation replay defense)", async (method) => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([jsonRes(401, { code: "PGRST303", message: "JWT issued at future" })]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x", { method });
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry a skew 401 when the method comes from a Request object (POST)", async () => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([jsonRes(401, { code: "PGRST303", message: "JWT issued at future" })]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const req = new Request("https://db.example/rest/v1/x", { method: "POST" });
    const res = await fetcher(req);
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry on HEAD: a real HEAD 401 is bodyless (RFC 9110 §9.3.2), so skew cannot be classified — retrying blind would retry every 401", async () => {
    const sleep = vi.fn(async () => {});
    // Bodyless 401 exactly as HEAD produces on the wire (no JSON, no body).
    const base = makeFetch([new Response(null, { status: 401 })]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x", { method: "HEAD" });
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("lowercase method strings are normalized (post is treated as a mutation)", async () => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([jsonRes(401, { code: "PGRST303", message: "JWT issued at future" })]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x", { method: "post" });
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("the returned 200 body is readable by the caller (clone used for inspection)", async () => {
    const sleep = vi.fn(async () => {});
    const payload = { rows: [1, 2, 3] };
    const base = makeFetch([jsonRes(401, { code: "PGRST303", message: "JWT issued at future" }), jsonRes(200, payload)]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x");
    expect(await res.json()).toEqual(payload);
  });

  it("passes through non-401 statuses untouched (e.g. 404)", async () => {
    const sleep = vi.fn(async () => {});
    const base = makeFetch([jsonRes(404, { error: "not found" })]);
    const fetcher = createSkewRetryFetch(base as unknown as typeof fetch, 350, sleep);
    const res = await fetcher("https://db.example/rest/v1/x");
    expect(res.status).toBe(404);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
