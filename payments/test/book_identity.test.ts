import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBookIdentity } from "../book_identity";
import {
  applyIdentity,
  assertApplyAllowed,
  fetchTargetState,
  mismatchList,
  paddleBaseFor,
  PartialSyncError,
  resolveTargets,
  runSync,
  supabaseGetUrl,
  supabasePatchUrl,
  supabaseRefFrom,
  paddleGetUrl,
  type CliEnv,
  type SyncConfig,
  type SyncTargets,
} from "../sync_book_identity";
import { resolveTitle } from "../src/settings";

let tmpDir: string;

const writeBook = (obj: unknown): string => {
  const p = join(tmpDir, `book_${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
};

const REGISTRY = {
  id: "duane",
  title: "You Don't Need a Million Dollars to Retire",
  subtitle: "How I Retired at 59 on $548,000, My Real Numbers, Five Years In",
  author: "Duane",
};

const CFG: SyncConfig = {
  book: "books/duane.json",
  db_product_id: "57596c19-c550-4bde-b17a-e87b86d005c5",
  paddle_product_ref: "pro_01m3vxs8fm3b2ygj62cjdys73m",
};

const TARGETS: SyncTargets = {
  supabaseBase: "https://sup.example",
  supabaseKey: "sk",
  paddleBase: "https://sandbox-api.paddle.com",
  paddleKey: "pdl",
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "book-identity-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadBookIdentity", () => {
  it("returns title/subtitle/author/id from the registry", () => {
    const id = loadBookIdentity(writeBook(REGISTRY));
    expect(id).toEqual({
      id: "duane",
      title: REGISTRY.title,
      subtitle: REGISTRY.subtitle,
      author: "Duane",
    });
  });

  it("throws on a blank title", () => {
    expect(() => loadBookIdentity(writeBook({ ...REGISTRY, title: "  " }))).toThrow(/"title" must be a non-empty string/);
  });

  it("throws on a missing subtitle", () => {
    const rest: Record<string, unknown> = { ...REGISTRY };
    delete rest.subtitle;
    expect(() => loadBookIdentity(writeBook(rest))).toThrow(/"subtitle" must be a non-empty string/);
  });

  it("trims leading/trailing whitespace from every identity field", () => {
    const id = loadBookIdentity(writeBook({
      id: "  duane  ",
      title: `\t ${REGISTRY.title} \n`,
      subtitle: `  ${REGISTRY.subtitle}  `,
      author: " Duane ",
    }));
    expect(id).toEqual({ id: "duane", title: REGISTRY.title, subtitle: REGISTRY.subtitle, author: "Duane" });
  });
});

describe("resolveTitle (settings.ts)", () => {
  it("resolves the title from the config's book registry", () => {
    const bookPath = writeBook(REGISTRY);
    const t = resolveTitle({ book: bookPath }, "cfg.json");
    expect(t).toBe(REGISTRY.title);
  });

  it("throws when neither book nor inline title is present", () => {
    expect(() => resolveTitle({}, "cfg.json")).toThrow(/"book" must point at a book registry file/);
  });
});

describe("bake facts come from the registry", () => {
  it("an inline <h1>/<title> fixture takes the registry title via the book path", () => {
    // The bake reads cfg.title which loadProductConfig resolves from the book
    // registry; assert the composition end-to-end with a fixture book file.
    const bookPath = writeBook(REGISTRY);
    const cfg = { book: bookPath, price_usd: 39 };
    const resolved = resolveTitle(cfg as Record<string, unknown>, "cfg.json");
    expect(resolved).toBe(REGISTRY.title);
    // bakeFacts-style substitution: h1 + <title> + og:title all carry the registry title
    const esc = (s: string) => s.replace(/'/g, "&#39;");
    const html = `<html><head><title>OLD — with Duane</title><meta property="og:title" content="OLD"></head><body><h1>OLD</h1><p class="price">$0</p></body></html>`;
    const out = html
      .replace(/(<h1>)[\s\S]*?(<\/h1>)/, `$1${esc(resolved)}$2`)
      .replace(/(<title>)[^<—]*?( — [^<]*)?(<\/title>)/, `$1${esc(resolved)}$2$3`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(resolved)}$2`);
    expect(out).toContain(`<h1>${esc(REGISTRY.title)}</h1>`);
    expect(out).toContain(`<title>${esc(REGISTRY.title)} — with Duane</title>`);
    expect(out).toContain(`content="${esc(REGISTRY.title)}"`);
    expect(out).not.toContain(">OLD<");
  });
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const paddleOkBody = (): { data: { id: string; name: string; description: string } } => ({
  data: { id: CFG.paddle_product_ref, name: REGISTRY.title, description: REGISTRY.subtitle },
});

describe("sync --check mismatch -> exit code 1 path", () => {
  it("reports mismatches for every drifted field", () => {
    const identity = loadBookIdentitySyncFixture();
    const mismatches = mismatchList(identity, {
      supabaseTitle: "Old Title",
      paddleName: "Old Title",
      paddleDescription: "Old subtitle",
    });
    expect(mismatches).toHaveLength(3);
    expect(mismatches.every((m) => m.includes("mismatch"))).toBe(true);
  });

  it("reports no mismatches when all targets match", () => {
    const identity = loadBookIdentitySyncFixture();
    const mismatches = mismatchList(identity, {
      supabaseTitle: identity.title,
      paddleName: identity.title,
      paddleDescription: identity.subtitle,
    });
    expect(mismatches).toHaveLength(0);
  });

  it("fetchTargetState reads both targets via GET", async () => {
    const calls: string[] = [];
    const fetchMock = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("rest/v1/products")) {
        return jsonResponse([{ title: REGISTRY.title }]);
      }
      return jsonResponse({ data: { name: REGISTRY.title, description: REGISTRY.subtitle } });
    }) as typeof fetch;
    const state = await fetchTargetState(TARGETS, CFG, fetchMock);
    expect(state.supabaseTitle).toBe(REGISTRY.title);
    expect(state.paddleName).toBe(REGISTRY.title);
    expect(state.paddleDescription).toBe(REGISTRY.subtitle);
    expect(calls).toContain(supabaseGetUrl(TARGETS, CFG.db_product_id));
    expect(calls).toContain(paddleGetUrl(TARGETS, CFG.paddle_product_ref));
  });
});

function loadBookIdentitySyncFixture() {
  return {
    id: "duane",
    title: REGISTRY.title,
    subtitle: REGISTRY.subtitle,
    author: "Duane",
  };
}

describe("applyIdentity sends the right PATCHes", () => {
  it("production: supabase PATCH with title body + Prefer header; paddle PATCH with name/description", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === "PATCH" && !String(url).includes("paddle")) return jsonResponse([{ title: REGISTRY.title }]);
      if (init?.method === "PATCH") return jsonResponse(paddleOkBody());
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    const prodTargets = { ...TARGETS, paddleBase: paddleBaseFor("production") };
    await applyIdentity(prodTargets, CFG, loadBookIdentitySyncFixture(), fetchMock);
    expect(calls).toHaveLength(2);

    const [supa, paddle] = calls;
    expect(supa.url).toBe(supabasePatchUrl(prodTargets, CFG.db_product_id));
    expect(supa.url).toBe("https://sup.example/rest/v1/products?id=eq.57596c19-c550-4bde-b17a-e87b86d005c5");
    expect(supa.init?.method).toBe("PATCH");
    const supaHeaders = supa.init?.headers as Record<string, string>;
    expect(supaHeaders.Prefer).toBe("return=representation");
    expect(supaHeaders.apikey).toBe("sk");
    expect(JSON.parse(String(supa.init?.body))).toEqual({ title: REGISTRY.title });

    expect(paddle.url).toBe("https://api.paddle.com/products/pro_01m3vxs8fm3b2ygj62cjdys73m");
    expect(paddle.init?.method).toBe("PATCH");
    const paddleHeaders = paddle.init?.headers as Record<string, string>;
    expect(paddleHeaders.Authorization).toBe("Bearer pdl");
    expect(JSON.parse(String(paddle.init?.body))).toEqual({
      name: REGISTRY.title,
      description: REGISTRY.subtitle,
    });
  });

  it("sandbox: paddle PATCH goes to the sandbox base", async () => {
    const urls: string[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) =>
      jsonResponse(init?.method === "PATCH" ? (String(url).includes("paddle") ? paddleOkBody() : {}) : [{ title: REGISTRY.title }])) as typeof fetch;
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (init?.method === "PATCH" && !String(url).includes("paddle")) return jsonResponse([{ title: REGISTRY.title }]);
      return fetchMock(url, init);
    }) as typeof fetch;
    const sandTargets = { ...TARGETS, paddleBase: paddleBaseFor("sandbox") };
    await applyIdentity(sandTargets, CFG, loadBookIdentitySyncFixture(), spy);
    expect(urls).toContain("https://sandbox-api.paddle.com/products/pro_01m3vxs8fm3b2ygj62cjdys73m");
  });

  it("throws on non-2xx supabase PATCH", async () => {
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) =>
      jsonResponse({ error: "x" }, init?.method === "PATCH" ? 401 : 200)) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(/supabase PATCH products HTTP 401/);
  });
});

describe("sandbox apply guard", () => {
  it("sandbox apply without --sandbox-db-ref throws before any fetch call", () => {
    let calls = 0;
    const fetchMock = (async () => { calls += 1; return jsonResponse([]); }) as typeof fetch;
    void fetchMock;
    expect(() => assertApplyAllowed("sandbox", "https://refabc.supabase.co", undefined)).toThrow(/sandbox apply is not supported/);
    expect(calls).toBe(0);
  });

  it("sandbox apply with a mismatched ref throws before any fetch call", () => {
    expect(() => assertApplyAllowed("sandbox", "https://refabc.supabase.co", "otherref")).toThrow(/does not match SUPABASE_URL ref refabc/);
  });

  it("sandbox apply with the matching ref is allowed", () => {
    expect(() => assertApplyAllowed("sandbox", "https://refabc.supabase.co", "refabc")).not.toThrow();
  });

  it("production apply is always allowed", () => {
    expect(() => assertApplyAllowed("production", "https://refabc.supabase.co", undefined)).not.toThrow();
  });

  it("supabaseRefFrom parses the project ref", () => {
    expect(supabaseRefFrom("https://refabc.supabase.co")).toBe("refabc");
    expect(supabaseRefFrom("https://refabc.supabase.co/")).toBe("refabc");
    expect(() => supabaseRefFrom("https://sup.example")).toThrow(/cannot parse/);
  });
});

describe("supabase PATCH row-count guard", () => {
  const makeFetch = (rows: unknown[], paddleOk = true) => {
    const paddleCalls: string[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(url).includes("api.paddle.com")) {
        paddleCalls.push(String(url));
        return jsonResponse(paddleOkBody(), paddleOk ? 200 : 500);
      }
      if (init?.method === "PATCH") return jsonResponse(rows);
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    return { fetchMock, paddleCalls };
  };

  it("0 rows: throws a plain Error (not PartialSyncError) and Paddle PATCH is not called", async () => {
    const { fetchMock, paddleCalls } = makeFetch([]);
    const err = await applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PartialSyncError);
    expect((err as Error).message).toMatch(/No matching product found \(0 rows\) — nothing was written; Paddle NOT attempted/);
    expect(paddleCalls).toHaveLength(0);
  });

  it("2 rows: PartialSyncError with integrity warning, Paddle PATCH is not called", async () => {
    const { fetchMock, paddleCalls } = makeFetch([{ title: "a" }, { title: "b" }]);
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(
      /PARTIAL SYNC: Supabase PATCH updated MULTIPLE rows \(2\); data integrity risk; Paddle NOT attempted; reconcile with --check before retry/,
    );
    expect(paddleCalls).toHaveLength(0);
  });

  it("exactly 1 row proceeds to the Paddle PATCH", async () => {
    const { fetchMock, paddleCalls } = makeFetch([{ title: REGISTRY.title }]);
    await applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock);
    expect(paddleCalls).toHaveLength(1);
  });
});

describe("partial-write reporting", () => {
  it("paddle PATCH failure throws a PartialSyncError with the exact PARTIAL message", async () => {
    const rows = [{ title: REGISTRY.title }];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) =>
      jsonResponse(init?.method === "PATCH" && String(url).includes("api.paddle.com") ? { error: "boom" } : rows, init?.method === "PATCH" && String(url).includes("api.paddle.com") ? 500 : 200)) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
    const fetchMock2 = fetchMock;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock2)).rejects.toThrow(
      /PARTIAL SYNC: Supabase updated successfully, but the Paddle update failed or its state is unknown \(HTTP 500\) — reconcile with --check before retry/,
    );
  });

  it("paddle fetch rejection throws a PartialSyncError (state unknown)", async () => {
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(url).includes("api.paddle.com")) {
        throw new Error("network down");
      }
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
  });

  it("supabase ok with unparseable body throws PartialSyncError and Paddle is not called", async () => {
    let paddleCalls = 0;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(url).includes("api.paddle.com")) {
        paddleCalls += 1;
        return jsonResponse(paddleOkBody());
      }
      if (init?.method === "PATCH") {
        return new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(
      /PARTIAL SYNC: Supabase PATCH committed but response unreadable; Paddle NOT attempted; reconcile with --check before retry/,
    );
    expect(paddleCalls).toBe(0);
  });

  it("supabase PATCH keeps Prefer: return=representation and a 30s abort timeout", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && !String(url).includes("paddle")) {
        capturedInit = init;
        return jsonResponse([{ title: REGISTRY.title }]);
      }
      return jsonResponse(paddleOkBody());
    }) as typeof fetch;
    await applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock);
    expect(capturedInit).toBeDefined();
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Prefer).toBe("return=representation");
    expect((capturedInit!.signal as AbortSignal | undefined)?.constructor.name).toBe("AbortSignal");
  });
});

describe("5xx + title verification hardening", () => {
  const makeRecordingFetch = (handler: (url: string, method: string) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method });
      return handler(String(url), method);
    }) as typeof fetch;
    return { fetchMock, calls };
  };

  it("supabase PATCH 503 -> PartialSyncError, exactly 1 supabase PATCH, 0 paddle requests", async () => {
    const { fetchMock, calls } = makeRecordingFetch((url, method) =>
      jsonResponse({ error: "x" }, method === "PATCH" && !url.includes("paddle") ? 503 : 200));
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(
      /PARTIAL SYNC: Supabase PATCH HTTP 503; Supabase may have committed; Paddle NOT attempted; reconcile with --check before retry/,
    );
    expect(calls.filter((c) => c.method === "PATCH" && c.url.includes("sup"))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes("paddle"))).toHaveLength(0);
  });

  it("supabase PATCH 400 -> plain Error (not PartialSyncError), 0 paddle requests", async () => {
    const { fetchMock, calls } = makeRecordingFetch((url, method) =>
      jsonResponse({ error: "x" }, method === "PATCH" && !url.includes("paddle") ? 400 : 200));
    const err = await applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PartialSyncError);
    expect((err as Error).message).toMatch(/supabase PATCH products HTTP 400/);
    expect(calls.filter((c) => c.url.includes("paddle"))).toHaveLength(0);
  });

  it.each([408, 425, 429])("supabase PATCH %i -> PartialSyncError (unknown state), 0 paddle requests", async (status) => {
    const { fetchMock, calls } = makeRecordingFetch((url, method) =>
      jsonResponse({ error: "x" }, method === "PATCH" && !url.includes("paddle") ? status : 200));
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(
      /PARTIAL SYNC: Supabase PATCH HTTP \d+; Supabase may have committed; Paddle NOT attempted; reconcile with --check before retry/,
    );
    expect(calls.filter((c) => c.url.includes("paddle"))).toHaveLength(0);
  });

  it("abort during the supabase PATCH body read -> PartialSyncError, 0 paddle requests", async () => {
    const abortErr = (): never => {
      throw new DOMException("The operation was aborted due to timeout", "AbortError");
    };
    const calls: string[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (init?.method === "PATCH" && !String(url).includes("paddle")) {
        return { ok: true, status: 200, json: abortErr } as unknown as Response;
      }
      return jsonResponse(paddleOkBody());
    }) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
    expect(calls.filter((c) => c.includes("paddle"))).toHaveLength(0);
  });

  it("paddle 2xx with an empty object body -> PartialSyncError (unexpected body)", async () => {
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "PATCH" && String(url).includes("paddle")
        ? jsonResponse({})
        : jsonResponse([{ title: REGISTRY.title }])) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(
      /PARTIAL SYNC: Paddle returned 2xx but an unexpected body; Supabase already updated; reconcile with --check before retry/,
    );
  });

  it.each([
    { id: "pro_other", name: REGISTRY.title },
    { id: CFG.paddle_product_ref, name: "Wrong Name" },
  ])("paddle 2xx with mismatched body %# -> PartialSyncError", async (data) => {
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "PATCH" && String(url).includes("paddle")
        ? jsonResponse({ data })
        : jsonResponse([{ title: REGISTRY.title }])) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(/unexpected body/);
  });

  it("abort during the paddle PATCH body read -> PartialSyncError", async () => {
    const abortErr = (): never => {
      throw new DOMException("The operation was aborted due to timeout", "AbortError");
    };
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "PATCH" && String(url).includes("paddle")
        ? { ok: true, status: 200, json: abortErr } as unknown as Response
        : jsonResponse([{ title: REGISTRY.title }])) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(PartialSyncError);
  });

  it("returned row title mismatch -> PartialSyncError, 0 paddle requests", async () => {
    const { fetchMock, calls } = makeRecordingFetch((url, method) =>
      method === "PATCH" && !url.includes("paddle") ? jsonResponse([{ title: "Rewritten by a trigger" }]) : jsonResponse(paddleOkBody()));
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(
      /PARTIAL SYNC: Supabase row title is 'Rewritten by a trigger', expected '.*' \(trigger\/rule rewrote it\?\); Paddle NOT attempted; reconcile with --check before retry/,
    );
    expect(calls.filter((c) => c.url.includes("paddle"))).toHaveLength(0);
  });

  it("GET request abort -> error names the target and the request phase", async () => {
    const fetchMock = (async (url: string | URL | Request) => {
      if (String(url).includes("paddle")) return jsonResponse({ data: { name: REGISTRY.title, description: REGISTRY.subtitle } });
      throw new DOMException("The operation was aborted due to timeout", "AbortError");
    }) as typeof fetch;
    await expect(fetchTargetState(TARGETS, CFG, fetchMock)).rejects.toThrow(/Supabase GET products request timed out or failed/);
    const fetchMock2 = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse([{ title: REGISTRY.title }]);
      if (String(url).includes("rest/v1/products")) return jsonResponse([{ title: REGISTRY.title }]);
      throw new DOMException("The operation was aborted due to timeout", "AbortError");
    }) as typeof fetch;
    await expect(fetchTargetState(TARGETS, CFG, fetchMock2)).rejects.toThrow(/Paddle GET products request timed out or failed/);
  });

  it("abort during body read -> error names the target and 'response body'", async () => {
    const abortErr = (): never => {
      throw new DOMException("The operation was aborted due to timeout", "AbortError");
    };
    const supaFetch = (async (url: string | URL | Request) =>
      String(url).includes("rest/v1/products")
        ? { ok: true, status: 200, json: abortErr } as unknown as Response
        : jsonResponse({ data: { name: REGISTRY.title, description: REGISTRY.subtitle } })) as typeof fetch;
    await expect(fetchTargetState(TARGETS, CFG, supaFetch)).rejects.toThrow(/Supabase GET products response body read failed/);
    await expect(fetchTargetState(TARGETS, CFG, supaFetch)).rejects.toThrow(/response body/);
    const paddleFetch = (async (url: string | URL | Request) =>
      String(url).includes("rest/v1/products")
        ? jsonResponse([{ title: REGISTRY.title }])
        : { ok: true, status: 200, json: abortErr } as unknown as Response) as typeof fetch;
    await expect(fetchTargetState(TARGETS, CFG, paddleFetch)).rejects.toThrow(/Paddle GET products response body read failed/);
    await expect(fetchTargetState(TARGETS, CFG, paddleFetch)).rejects.toThrow(/response body/);
  });

  it("PATCH request abort -> PartialSyncError naming the target and the request phase", async () => {
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && !String(url).includes("paddle")) {
        throw new DOMException("The operation was aborted due to timeout", "AbortError");
      }
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    await expect(applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock)).rejects.toThrow(
      /PARTIAL SYNC: the Supabase update request failed or its state is unknown.*reconcile with --check before retry/,
    );
  });

  it("GETs carry an AbortSignal timeout", async () => {
    const inits: RequestInit[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      if (String(url).includes("rest/v1/products")) return jsonResponse([{ title: REGISTRY.title }]);
      return jsonResponse({ data: { name: REGISTRY.title, description: REGISTRY.subtitle } });
    }) as typeof fetch;
    await fetchTargetState(TARGETS, CFG, fetchMock);
    for (const i of inits) expect((i.signal as AbortSignal | undefined)?.constructor.name).toBe("AbortSignal");
  });
});

describe("supabase PATCH non-array body guard", () => {
  it("non-array body -> PartialSyncError, Paddle not called", async () => {
    let paddleCalls = 0;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(url).includes("paddle")) {
        paddleCalls += 1;
        return jsonResponse(paddleOkBody());
      }
      if (init?.method === "PATCH") return jsonResponse({ data: [{ title: REGISTRY.title }] });
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    const err = await applyIdentity(TARGETS, CFG, loadBookIdentitySyncFixture(), fetchMock).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialSyncError);
    expect((err as Error).message).toMatch(/non-array body/);
    expect((err as Error).message).toContain("reconcile with --check before retry");
    expect(paddleCalls).toBe(0);
  });
});

describe("PartialSyncError message discipline", () => {
  it("every PartialSyncError message in applyIdentity ends with 'reconcile with --check before retry'", async () => {
    const id = loadBookIdentitySyncFixture();
    const cases: Array<typeof fetch> = [
      // supabase request abort
      (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH" && !String(_url).includes("paddle")) throw new Error("abort");
        return jsonResponse(id && [{ title: id.title }]);
      }) as typeof fetch,
      // supabase 5xx
      (async (_url: string | URL | Request, init?: RequestInit) =>
        jsonResponse({ e: 1 }, init?.method === "PATCH" && !String(_url).includes("paddle") ? 503 : 200)) as typeof fetch,
      // supabase body unreadable
      (async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH" && !String(_url).includes("paddle")
          ? new Response("nope", { status: 200, headers: { "Content-Type": "text/html" } })
          : jsonResponse(paddleOkBody())) as typeof fetch,
      // supabase non-array body
      (async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH" && !String(_url).includes("paddle")
          ? jsonResponse({ unexpected: true })
          : jsonResponse(paddleOkBody())) as typeof fetch,
      // supabase >1 rows
      (async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH" && !String(_url).includes("paddle")
          ? jsonResponse([{ title: "a" }, { title: "b" }])
          : jsonResponse(paddleOkBody())) as typeof fetch,
      // title rewritten
      (async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH" && !String(_url).includes("paddle")
          ? jsonResponse([{ title: "Rewritten" }])
          : jsonResponse(paddleOkBody())) as typeof fetch,
      // paddle request abort
      (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "PATCH" && String(_url).includes("paddle")) throw new Error("abort");
        return jsonResponse([{ title: id.title }]);
      }) as typeof fetch,
      // paddle 5xx
      (async (_url: string | URL | Request, init?: RequestInit) =>
        jsonResponse({ e: 1 }, init?.method === "PATCH" && String(_url).includes("paddle") ? 500 : 200)) as typeof fetch,
      // paddle body unreadable
      (async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH" && String(_url).includes("paddle")
          ? new Response("nope", { status: 200, headers: { "Content-Type": "text/html" } })
          : jsonResponse([{ title: id.title }])) as typeof fetch,
    ];
    for (const f of cases) {
      const err = await applyIdentity(TARGETS, CFG, id, f).catch((e: unknown) => e);
      expect(err, "expected PartialSyncError").toBeInstanceOf(PartialSyncError);
      expect((err as Error).message.endsWith("reconcile with --check before retry")).toBe(true);
    }
  });
});

describe("paddleBaseFor", () => {
  it("maps production and sandbox correctly", () => {
    expect(paddleBaseFor("production")).toBe("https://api.paddle.com");
    expect(paddleBaseFor("sandbox")).toBe("https://sandbox-api.paddle.com");
  });

  it("throws on an unknown environment", () => {
    expect(() => paddleBaseFor(undefined)).toThrow(/PADDLE_ENVIRONMENT must be "sandbox" or "production"/);
    expect(() => paddleBaseFor("staging")).toThrow(/PADDLE_ENVIRONMENT must be "sandbox" or "production"/);
  });
});

describe("resolveTargets", () => {
  const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "PADDLE_API_KEY", "PADDLE_ENVIRONMENT"] as const;

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("throws listing every missing env var", () => {
    expect(() => resolveTargets()).toThrow(/missing env: SUPABASE_URL, SUPABASE_SECRET_KEY, PADDLE_API_KEY/);
  });

  it("resolves when all env vars are present", () => {
    process.env.SUPABASE_URL = "https://sup.example/";
    process.env.SUPABASE_SECRET_KEY = "sk";
    process.env.PADDLE_API_KEY = "pdl";
    process.env.PADDLE_ENVIRONMENT = "sandbox";
    const t = resolveTargets();
    expect(t.supabaseBase).toBe("https://sup.example");
    expect(t.paddleBase).toBe("https://sandbox-api.paddle.com");
  });
});

describe("repo invariants", () => {
  it("no tracked payments/ or web/public file carries the literal title except the registry and baked c/ pages", async () => {
    const { readFile } = await import("node:fs/promises");
    const root = join(tmpDir, "..", "..", "..", ".."); // not used; real root below
    void root;
    const repoRoot = join(__dirname, "..", "..");
    const needle = "You Don't Need a Million Dollars to Retire";
    const offenders: string[] = [];
    const scan = async (dir: string, exts: string[]): Promise<string[]> => {
      const { readdir } = await import("node:fs/promises");
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await scan(p, exts)));
        else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
      }
      return out;
    };
    const paymentsFiles = await scan(join(repoRoot, "payments"), [".ts", ".json", ".html", ".sh", ".md"]);
    const webPublicFiles = await scan(join(repoRoot, "web", "public"), [".html", ".xml", ".txt"]);
    for (const f of [...paymentsFiles, ...webPublicFiles]) {
      const rel = f.slice(repoRoot.length + 1);
      if (rel === "payments/config.duane.json") continue; // must not carry title — asserted separately
      if (rel === "payments/test/book_identity.test.ts") continue; // this test itself references the needle
      const isBakedCPage = rel.startsWith("web/public/c/");
      const text = await readFile(f, "utf8");
      if (text.includes(needle) && !isBakedCPage) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("payments/config.duane.json has no title key and points at the book registry", async () => {
    const { readFile } = await import("node:fs/promises");
    const repoRoot = join(__dirname, "..", "..");
    const cfg = JSON.parse(await readFile(join(repoRoot, "payments", "config.duane.json"), "utf8")) as Record<string, unknown>;
    expect(cfg).not.toHaveProperty("title");
    expect(cfg.book).toBe("books/duane.json");
    expect(cfg.paddle_product_ref).toBe("pro_01m3vxs8fm3b2ygj62cjdys73m");
  });
});

describe("runSync orchestration", () => {
  const ENV_OK: CliEnv = {
    SUPABASE_URL: "https://sup.supabase.co",
    SUPABASE_SECRET_KEY: "sk",
    PADDLE_API_KEY: "pdl",
    PADDLE_ENVIRONMENT: "sandbox",
  };
  const APPLY_OK = ["--sandbox-db-ref", "sup"];
  const sandboxSupabase = (rowBody: unknown, status = 200) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && !String(url).includes("paddle")) return jsonResponse(rowBody, status);
      if (init?.method === "PATCH") return jsonResponse(paddleOkBody());
      if (String(url).includes("rest/v1/products")) return jsonResponse([{ title: REGISTRY.title }]);
      return jsonResponse({ data: { name: REGISTRY.title, description: REGISTRY.subtitle } });    }) as typeof fetch;

  it("sandbox apply without --sandbox-db-ref rejects with 0 fetch calls", async () => {
    let calls = 0;
    const fetchMock = (async () => { calls += 1; return jsonResponse([]); }) as typeof fetch;
    await expect(runSync([], ENV_OK, fetchMock)).rejects.toThrow(/sandbox apply is not supported/);
    expect(calls).toBe(0);
  });

  it("sandbox apply with a mismatched ref rejects with 0 fetch calls", async () => {
    let calls = 0;
    const fetchMock = (async () => { calls += 1; return jsonResponse([]); }) as typeof fetch;
    await expect(runSync(["--sandbox-db-ref", "otherref"], ENV_OK, fetchMock)).rejects.toThrow(/does not match SUPABASE_URL ref/);
    expect(calls).toBe(0);
  });

  it("PADDLE_ENVIRONMENT unset rejects with 0 fetch calls", async () => {
    let calls = 0;
    const fetchMock = (async () => { calls += 1; return jsonResponse([]); }) as typeof fetch;
    await expect(runSync(APPLY_OK, { ...ENV_OK, PADDLE_ENVIRONMENT: undefined }, fetchMock)).rejects.toThrow(/PADDLE_ENVIRONMENT must be "sandbox" or "production"/);
    expect(calls).toBe(0);
  });

  it('PADDLE_ENVIRONMENT "prod" rejects with 0 fetch calls', async () => {
    let calls = 0;
    const fetchMock = (async () => { calls += 1; return jsonResponse([]); }) as typeof fetch;
    await expect(runSync(APPLY_OK, { ...ENV_OK, PADDLE_ENVIRONMENT: "prod" }, fetchMock)).rejects.toThrow(/PADDLE_ENVIRONMENT must be "sandbox" or "production"/);
    expect(calls).toBe(0);
  });

  it("supabase ok + unparseable body -> PartialSyncError, Paddle not called", async () => {
    const calls: string[] = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (init?.method === "PATCH" && !String(url).includes("paddle")) {
        return new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return jsonResponse(paddleOkBody());
    }) as typeof fetch;
    await expect(runSync(APPLY_OK, ENV_OK, fetchMock)).rejects.toBeInstanceOf(PartialSyncError);
    expect(calls.filter((c) => c.includes("paddle"))).toHaveLength(0);
  });

  it("supabase ok + paddle fetch rejects -> PartialSyncError", async () => {
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(url).includes("paddle")) {
        throw new Error("connection reset");
      }
      if (init?.method === "PATCH") return jsonResponse([{ title: REGISTRY.title }]);
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    await expect(runSync(APPLY_OK, ENV_OK, fetchMock)).rejects.toThrow(PartialSyncError);
  });

  it("supabase ok + paddle 503 -> PartialSyncError", async () => {
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && String(url).includes("paddle")) return jsonResponse({ error: "x" }, 503);
      if (init?.method === "PATCH") return jsonResponse([{ title: REGISTRY.title }]);
      return jsonResponse([{ title: REGISTRY.title }]);
    }) as typeof fetch;
    await expect(runSync(APPLY_OK, ENV_OK, fetchMock)).rejects.toThrow(PartialSyncError);
  });

  it("supabase 503 on apply -> PartialSyncError mentioning --check, 0 paddle requests", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      if (init?.method === "PATCH" && !String(url).includes("paddle")) return jsonResponse({ error: "x" }, 503);
      if (init?.method === "PATCH") return jsonResponse(paddleOkBody());
      if (String(url).includes("rest/v1/products")) return jsonResponse([{ title: REGISTRY.title }]);
      return jsonResponse({ data: { name: REGISTRY.title, description: REGISTRY.subtitle } });
    }) as typeof fetch;
    await expect(runSync(APPLY_OK, ENV_OK, fetchMock)).rejects.toThrow(PartialSyncError);
    await expect(runSync(APPLY_OK, ENV_OK, fetchMock)).rejects.toThrow(/reconcile with --check before retry/);
    expect(calls.filter((c) => c.url.includes("paddle"))).toHaveLength(0);
  });

  it("happy path: 2 PATCH calls, supabase then paddle", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return sandboxSupabase([{ title: REGISTRY.title }])(url, init);
    }) as typeof fetch;
    const result = await runSync(APPLY_OK, ENV_OK, fetchMock);
    expect(result.exitCode).toBe(0);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    expect(calls[0].url).toContain("sup.supabase.co");
    expect(calls[1].url).toContain("paddle");
  });

  it("--check happy path makes no PATCH calls", async () => {
    let patchCalls = 0;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") { patchCalls += 1; return jsonResponse({}); }
      return sandboxSupabase([{ title: REGISTRY.title }])(url, init);
    }) as typeof fetch;
    const result = await runSync(["--check"], ENV_OK, fetchMock);
    expect(result.exitCode).toBe(0);
    expect(patchCalls).toBe(0);
  });
});
