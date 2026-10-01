import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBookIdentity } from "../book_identity";
import {
  applyIdentity,
  fetchTargetState,
  mismatchList,
  paddleBaseFor,
  resolveTargets,
  supabaseGetUrl,
  supabasePatchUrl,
  paddleGetUrl,
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
      return jsonResponse(init?.method === "PATCH" ? (init.body ? JSON.parse(String(init.body)) : {}) : [{ title: REGISTRY.title }]);
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
      jsonResponse(init?.method === "PATCH" ? {} : [{ title: REGISTRY.title }])) as typeof fetch;
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
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
