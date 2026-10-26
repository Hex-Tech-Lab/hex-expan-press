import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCache, type ErrorReporter, type RedisPort } from "../engine/cache";

function fakePort(overrides: Partial<RedisPort> = {}) {
  const store = new Map<string, string>();
  const port: RedisPort = {
    getRedisValue: vi.fn(async (key: string) => store.get(key) ?? null),
    setRedisValue: vi.fn(async (key: string, raw: string) => {
      store.set(key, raw);
      return "OK";
    }),
    deleteRedisKey: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    ...overrides,
  };
  return { port, store };
}

function fakeReporter(overrides: Partial<ErrorReporter> = {}): ErrorReporter {
  return { report: vi.fn(), ...overrides };
}

describe("createCache", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  test("uses the in-memory cache when Redis is not requested, even with a port", () => {
    const { port } = fakePort();
    const cache = createCache(false, port);
    cache.set("k", { a: 1 });
    expect(cache.get("k")).toEqual({ a: 1 });
    expect(port.setRedisValue).not.toHaveBeenCalled();
  });

  test("uses the in-memory cache when Redis is requested but no port is injected", () => {
    const cache = createCache(true);
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
  });

  test("the in-memory cache treats an expired entry as absent and drops it", () => {
    const cache = createCache(false);
    cache.set("k", "v", -1);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.get("k")).toBeUndefined();
  });

  test("the in-memory cache del removes an entry", () => {
    const cache = createCache(false);
    cache.set("k", "v");
    cache.del("k");
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("RedisCache", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  test("set serialises the value through the port with the TTL; get parses it back", async () => {
    const { port } = fakePort();
    const cache = createCache(true, port);
    await cache.set("k", { a: 1 });
    expect(port.setRedisValue).toHaveBeenCalledWith("k", '{"a":1}', 3600);
    await expect(cache.get("k")).resolves.toEqual({ a: 1 });
  });

  test("set passes an explicit TTL through", async () => {
    const { port } = fakePort();
    await createCache(true, port).set("k", "v", 90);
    expect(port.setRedisValue).toHaveBeenCalledWith("k", '"v"', 90);
  });

  test("two sequential writes to the same key both reach the port", async () => {
    const { port } = fakePort();
    const cache = createCache(true, port);
    await cache.set("k", 1);
    await cache.set("k", 2);
    expect(port.setRedisValue).toHaveBeenCalledTimes(2);
  });

  test("two concurrent writes to the same key share one in-flight write", async () => {
    const { port } = fakePort();
    const cache = createCache(true, port) as { set: (k: string, v: unknown) => Promise<void> };
    await Promise.all([cache.set("k", 1), cache.set("k", 1)]);
    expect(port.setRedisValue).toHaveBeenCalledTimes(1);
  });

  test("a missing or null value reads as undefined", async () => {
    const { port } = fakePort({ getRedisValue: vi.fn(async () => undefined) });
    await expect(createCache(true, port).get("k")).resolves.toBeUndefined();
    const nullPort = fakePort();
    await expect(createCache(true, nullPort.port).get("absent")).resolves.toBeUndefined();
  });

  test("a corrupt cache entry is logged, reported, and read as undefined", async () => {
    const reporter = fakeReporter();
    const { port } = fakePort({ getRedisValue: vi.fn(async () => "{not json") });
    await expect(createCache(true, port, reporter).get("k")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[redis-cache]", expect.objectContaining({ operation: "get" }));
    expect(reporter.report).toHaveBeenCalledWith(expect.any(SyntaxError), { method: "get" });
  });

  test.each(["get", "set", "del"] as const)("a %s failure is logged, reported, and does not throw", async (op) => {
    const boom = new Error("redis down");
    const reporter = fakeReporter();
    const failing: Partial<RedisPort> = {
      getRedisValue: vi.fn(async () => { throw boom; }),
      setRedisValue: vi.fn(async () => { throw boom; }),
      deleteRedisKey: vi.fn(async () => { throw boom; }),
    };
    const cache = createCache(true, fakePort(failing).port, reporter) as {
      get: (k: string) => Promise<unknown>;
      set: (k: string, v: unknown) => Promise<void>;
      del: (k: string) => Promise<void>;
    };
    if (op === "get") await expect(cache.get("k")).resolves.toBeUndefined();
    if (op === "set") await expect(cache.set("k", 1)).resolves.toBeUndefined();
    if (op === "del") await expect(cache.del("k")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[redis-cache]", { message: "redis down", operation: op });
    expect(reporter.report).toHaveBeenCalledWith(boom, { method: op });
  });

  test.each(["get", "set", "del"] as const)("a non-Error %s rejection is logged as its string value", async (op) => {
    const failing: Partial<RedisPort> = {
      getRedisValue: vi.fn(async () => { throw "plain string"; }),
      setRedisValue: vi.fn(async () => { throw "plain string"; }),
      deleteRedisKey: vi.fn(async () => { throw "plain string"; }),
    };
    const cache = createCache(true, fakePort(failing).port) as {
      get: (k: string) => Promise<unknown>;
      set: (k: string, v: unknown) => Promise<void>;
      del: (k: string) => Promise<void>;
    };
    if (op === "get") await cache.get("k");
    if (op === "set") await cache.set("k", 1);
    if (op === "del") await cache.del("k");
    expect(errors).toHaveBeenCalledWith("[redis-cache]", { message: "plain string", operation: op });
  });

  test("a failing reporter is logged and does not escape the cache call", async () => {
    const reporter = fakeReporter({ report: vi.fn(() => { throw new Error("reporter down"); }) });
    const { port } = fakePort({ getRedisValue: vi.fn(async () => { throw new Error("redis down"); }) });
    await expect(createCache(true, port, reporter).get("k")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[redis-cache-reporter]", expect.any(Error));
  });

  test("with no reporter injected, a failure is still logged and swallowed", async () => {
    const { port } = fakePort({ deleteRedisKey: vi.fn(async () => { throw new Error("redis down"); }) });
    await expect(createCache(true, port).del("k")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("[redis-cache]", { message: "redis down", operation: "del" });
  });

  test("a refused write does not block a later valid write to the same key", async () => {
    const { port } = fakePort();
    const cache = createCache(true, port) as { set: (k: string, v: unknown) => Promise<void> };
    await cache.set("k", { getFilePath: () => "x.ts" });
    await cache.set("k", { ok: true });
    expect(port.setRedisValue).toHaveBeenCalledTimes(1);
    expect(port.setRedisValue).toHaveBeenCalledWith("k", '{"ok":true}', 3600);
  });

  test("an AST object is refused before it reaches Redis, and is logged", async () => {
    const { port } = fakePort();
    const cache = createCache(true, port) as { set: (k: string, v: unknown) => Promise<void> };
    await cache.set("k", { getFilePath: () => "x.ts" });
    expect(port.setRedisValue).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("[redis-cache]", {
      message: "Cannot serialize AST/SourceFile objects to RedisCache backend.",
      operation: "set",
    });
  });

  test("a plain object that names none of the AST markers is stored", async () => {
    const { port } = fakePort();
    const cache = createCache(true, port) as { set: (k: string, v: unknown) => Promise<void> };
    await cache.set("k", { getFilePathLike: 1 });
    expect(port.setRedisValue).toHaveBeenCalledTimes(1);
  });

  test("a falsy value skips the AST check and is stored", async () => {
    const { port } = fakePort();
    await (createCache(true, port) as { set: (k: string, v: unknown) => Promise<void> }).set("k", null);
    expect(port.setRedisValue).toHaveBeenCalledWith("k", "null", 3600);
  });

  test("del removes the key through the port", async () => {
    const { port, store } = fakePort();
    const cache = createCache(true, port) as { set: (k: string, v: unknown) => Promise<void>; del: (k: string) => Promise<void> };
    await cache.set("k", "v");
    await cache.del("k");
    expect(store.has("k")).toBe(false);
  });
});
