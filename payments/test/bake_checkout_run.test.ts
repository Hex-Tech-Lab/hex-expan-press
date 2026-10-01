import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BakeDeps,
  BakeSummary,
  PADDLE_MARKER_START,
  primaryPaddle,
  runBake,
} from "../bake_checkout";

const DB_ID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const KINDS = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "PADDLE_ENVIRONMENT", "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};
const stashEnv = () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// In-memory fake fs: Map of path -> html (or raw string).
const makeMemFs = (initial: Record<string, string> = {}) => {
  const files = new Map<string, string>(Object.entries(initial));
  const deps: BakeDeps = {
    siteRoot: "site-root",
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFileAtomic: (p, html) => {
      files.set(p, html);
    },
    listProductDirs: async () => [],
    loadConfig: async (assoc) => ({
      cfg: assoc ? { title: "T", price_usd: 19, checkout_mode: "paddle", paddle_price_id: "pri_abc123", paddle_product_id: "prod_x", db_product_id: DB_ID } : { title: "T", price_usd: 19 },
      source: "cfg.json",
    }),
    fetchImpl: async () => {
      throw new Error("unexpected fetch");
    },
    now: () => "2026-10-01T00:00:00.000Z",
    log: () => {},
  };
  return { files, deps };
};

const PADDLE_PAGE = (body: string): string =>
  `<html><head><title>Old — site</title></head><body><div class="wrap"><h1>Old</h1><p class="price">$9</p>${body}</div></body></html>`;

const activePaddleBlock = (): string =>
  primaryPaddle(
    "cfg.json",
    { priceId: "pri_old123", clientToken: "live_old", productId: "prod_old", environment: "production" },
    "2026-09-01T00:00:00.000Z",
  );

const preMarkerPaddlePage = (): string =>
  PADDLE_PAGE(
    `<button type="button" class="buy" id="buy" data-checkout-slot="primary" data-checkout-mode="paddle">Buy now</button>\n` +
      `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>\n` +
      `<script>window.Paddle.Initialize({ token: "test_123" });</script>`,
  );

const legacyMasterPage = (): string =>
  `<html><head><title>Master — site</title></head><body><div class="wrap"><h1>M</h1>` +
  `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>\n` +
  `<a data-checkout-slot="primary" data-checkout-mode="gated">Gated</a></div></body></html>`;

const okConsents = (): Response =>
  ({
    ok: true,
    status: 200,
    json: async () =>
      KINDS.map((k, i) => ({ id: `row-${k}`, kind: k, decision: "given", signed_at: `2026-09-0${i + 1}T00:00:00Z`, supersedes: null })),
  }) as unknown as Response;

const baseEnv = () => {
  stashEnv();
  process.env.SUPABASE_URL = "https://sup.example";
  process.env.SUPABASE_SECRET_KEY = "sk";
  process.env.PADDLE_ENVIRONMENT = "production";
  process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = "live_tok";
};

const runWithProductDirs = async (
  { deps }: { files: Map<string, string>; deps: BakeDeps },
  dirs: string[],
  fetchImpl?: BakeDeps["fetchImpl"],
): Promise<BakeSummary> => {
  // Product dirs always bake in paddle mode regardless of the global
  // creators.json association map (empty under the in-memory fake fs).
  const full: BakeDeps = {
    ...deps,
    listProductDirs: async () => dirs,
    fetchImpl: fetchImpl ?? deps.fetchImpl,
    loadConfig: async () => ({
      cfg: { title: "T", price_usd: 19, checkout_mode: "paddle", paddle_price_id: "pri_abc123", paddle_product_id: "prod_x", db_product_id: DB_ID },
      source: "cfg.json",
    }),
  };
  return runBake(full);
};

describe("runBake — safe fallback (P1)", () => {
  it("(a) active Paddle page + refused C1 head → blocked, gated slot, zero Paddle traces", async () => {
    baseEnv();
    const { files, deps } = makeMemFs({
      "site-root/public/c/duane/book/index.html": PADDLE_PAGE(activePaddleBlock()),
    });
    // given -> refused chain on C1
    const refusedRes = {
      ok: true,
      status: 200,
      json: async () => [
        { id: "r1", kind: "C1_data_accuracy", decision: "given", signed_at: "2026-09-01T00:00:00Z", supersedes: null },
        { id: "r2", kind: "C1_data_accuracy", decision: "refused", signed_at: "2026-09-05T00:00:00Z", supersedes: "r1" },
        { id: "r3", kind: "C2_release_approval", decision: "given", signed_at: "2026-09-02T00:00:00Z", supersedes: null },
        { id: "r4", kind: "C3_revenue_split", decision: "given", signed_at: "2026-09-03T00:00:00Z", supersedes: null },
      ],
    } as unknown as Response;
    const summary = await runWithProductDirs({ files, deps }, ["duane/book"], async () => refusedRes);
    expect(summary.blocked).toEqual([
      { page: join("site", "c", "duane", "book", "index.html"), reason: expect.stringMatching(/refused/) },
    ]);
    expect(summary.baked).toContain(join("site", "c", "duane", "book", "index.html"));
    const out = files.get("site-root/public/c/duane/book/index.html")!;
    expect(out).toContain('data-checkout-mode="gated"');
    expect(out).toContain("<a");
    expect(out).not.toContain("cdn.paddle.com");
    expect(out).not.toContain("Paddle.Initialize");
    expect(out).not.toContain("paddle-checkout:start");
  });

  it("(e) all consents valid → exactly one paddle marker block, blocked empty", async () => {
    baseEnv();
    const { files, deps } = makeMemFs({
      "site-root/public/c/duane/book/index.html": PADDLE_PAGE(activePaddleBlock()),
    });
    const summary = await runWithProductDirs({ files, deps }, ["duane/book"], async () => okConsents());
    expect(summary.blocked).toEqual([]);
    const out = files.get("site-root/public/c/duane/book/index.html")!;
    expect(out.match(/paddle-checkout:start/g)?.length).toBe(1);
    expect(out.match(/paddle-checkout:end/g)?.length).toBe(1);
  });
});

describe("runBake — sanitize always", () => {
  it("(b) slotless page with legacy Paddle scripts → rewritten with no Paddle traces", async () => {
    const { files, deps } = makeMemFs({
      "site-root/public/c/duane/index.html":
        `<html><body><h1>Hub</h1><script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>` +
        `<script>window.Paddle.Checkout.open({});</script></body></html>`,
    });
    // runBake only reads pages under public/c through listProductDirs, so the
    // slotless hub page must be registered there to be visited.
    const summary = await runWithProductDirs({ files, deps }, ["duane"]);
    expect(summary.blocked).toEqual([]);
    const out = files.get("site-root/public/c/duane/index.html")!;
    expect(out).not.toContain("cdn.paddle.com");
    expect(out).not.toContain("Paddle.Checkout");
    expect(out).not.toContain("Paddle.Initialize");
  });

  it("(c) pre-marker Paddle page baked gated (consents refused) → gated slot, no traces", async () => {
    baseEnv();
    const { files, deps } = makeMemFs({
      "site-root/public/c/duane/book/index.html": preMarkerPaddlePage(),
    });
    const summary = await runWithProductDirs({ files, deps }, ["duane/book"]);
    expect(summary.blocked.length).toBe(1);
    const out = files.get("site-root/public/c/duane/book/index.html")!;
    expect(out).not.toContain("cdn.paddle.com");
    expect(out).not.toContain("Paddle.Initialize");
    expect(out).toContain('data-checkout-mode="gated"');
    expect(out).not.toContain("<button");
  });

  it("(d) legacy master page with stale Paddle scripts → sanitized", async () => {
    const { files, deps } = makeMemFs({ "site-root/index.html": legacyMasterPage() });
    const summary = await runBake(deps);
    expect(summary.blocked).toEqual([]);
    const out = files.get("site-root/index.html")!;
    expect(out).not.toContain("cdn.paddle.com");
    expect(out).toContain('data-checkout-slot="primary"');
  });
});

describe("runBake — atomic write (real tmpdir)", () => {
  it("(f) writeFileAtomic writes via tmp file + rename, no leftovers", async () => {
    baseEnv();
    const dir = mkdtempSync(join(tmpdir(), "bake-atomic-"));
    try {
      const pageDir = join(dir, "public", "c", "duane", "book");
      mkdirSync(pageDir, { recursive: true });
      const page = join(pageDir, "index.html");
      writeFileSync(page, PADDLE_PAGE(activePaddleBlock()), "utf8");
      const { deps } = makeMemFs();
      const atomicDeps: BakeDeps = {
        ...deps,
        siteRoot: dir,
        readFile: async (p) => readFileSync(p, "utf8"),
        writeFileAtomic: (p, html) => {
          const tmp = `${p}.tmp-${process.pid}`;
          writeFileSync(tmp, html, "utf8");
          renameSync(tmp, p);
        },
        listProductDirs: async () => ["duane/book"],
        loadConfig: async () => ({
          cfg: { title: "T", price_usd: 19, checkout_mode: "paddle", paddle_price_id: "pri_abc123", paddle_product_id: "prod_x", db_product_id: DB_ID },
          source: "cfg.json",
        }),
        fetchImpl: async () => okConsents(),
      };
      const summary = await runBake(atomicDeps);
      expect(summary.baked).toContain(join("site", "c", "duane", "book", "index.html"));
      const entries = readdirSync(dir);
      expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
      expect(readFileSync(page, "utf8")).toContain(PADDLE_MARKER_START);
      expect(existsSync(`${page}.tmp-${process.pid}`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
