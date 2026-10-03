import { afterEach, describe, expect, it } from "vitest";
import {
  assertLaunchConsents,
  bakeFacts,
  ConsentRow,
  Facts,
  loadProductConfig,
  paddleEnvironment,
  paddleTokenForEnv,
  primaryPaddle,
  resolveProductTitle,
  stripPaddleBlocks,
  swap,
} from "../bake_checkout";
import { loadBookIdentity } from "../book_identity";

const DB_ID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const KINDS = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];

const okRes = (rows: unknown) =>
  ({ ok: true, status: 200, json: async () => rows }) as unknown as Response;
const errRes = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
const makeRow = (
  id: string,
  kind: string,
  decision: string,
  signed_at: string | null = "2026-09-01T00:00:00Z",
  supersedes: string | null = null,
): ConsentRow => ({ id, kind, decision, signed_at, supersedes, document_sha256: SHA });

const SHA = "c".repeat(64);
const okProductsRes = (): Response =>
  ({ ok: true, status: 200, json: async () => [{ release_sha256: SHA }] }) as unknown as Response;
const okFetchRes = (rows: unknown) => async (url: unknown): Promise<Response> =>
  String(url).includes("/products") ? okProductsRes() : okRes(rows);

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

describe("assertLaunchConsents", () => {
  it("passes when all three kinds are given (latest row each)", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    let called = false;
    await assertLaunchConsents(
      DB_ID,
      async (url) => {
        called = true;
        return await okFetchRes(KINDS.map((k, i) => makeRow(`row-${k}`, k, "given", `2026-09-0${i + 1}T00:00:00Z`)))(url);
      },
    );
    expect(called).toBe(true);
  });

  it("throws naming C3 when C3 is missing", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async () =>
          okRes([
            makeRow("1", "C1_data_accuracy", "given", "2026-09-01T00:00:00Z"),
            makeRow("2", "C2_release_approval", "given", "2026-09-02T00:00:00Z"),
          ]),
      ),
    ).rejects.toThrow(/C3_revenue_split/);
  });

  it("throws when newer refused supersedes older given", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async () =>
          okRes([
            makeRow("r1", "C1_data_accuracy", "given", "2026-09-01T00:00:00Z", null),
            makeRow("r2", "C1_data_accuracy", "refused", "2026-09-05T00:00:00Z", "r1"),
            makeRow("r3", "C2_release_approval", "given", "2026-09-02T00:00:00Z", null),
            makeRow("r4", "C3_revenue_split", "given", "2026-09-03T00:00:00Z", null),
          ]),
      ),
    ).rejects.toThrow(/C1_data_accuracy.*refused/);
  });

  it("passes when chain is given->refused->given (head is given)", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async (url) =>
          String(url).includes("/products")
            ? okProductsRes()
            : okRes([
              makeRow("r1", "C1_data_accuracy", "given", "2026-09-01T00:00:00Z", null),
              makeRow("r2", "C1_data_accuracy", "refused", "2026-09-02T00:00:00Z", "r1"),
              makeRow("r3", "C1_data_accuracy", "given", "2026-09-03T00:00:00Z", "r2"),
              makeRow("r4", "C2_release_approval", "given", "2026-09-02T00:00:00Z", null),
              makeRow("r5", "C3_revenue_split", "given", "2026-09-03T00:00:00Z", null),
            ]),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws when two rows have the same signed_at but conflicting decision (given + refused)", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async () =>
          okRes([
            makeRow("r1", "C1_data_accuracy", "given", "2026-09-01T12:00:00Z", null),
            makeRow("r2", "C1_data_accuracy", "refused", "2026-09-01T12:00:00Z", null),
            makeRow("r3", "C2_release_approval", "given", "2026-09-02T00:00:00Z", null),
            makeRow("r4", "C3_revenue_split", "given", "2026-09-03T00:00:00Z", null),
          ]),
      ),
    ).rejects.toThrow(/launch blocked/);
  });

  it("throws when there are two heads for a kind (forked chain)", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async () =>
          okRes([
            makeRow("r1", "C1_data_accuracy", "given", "2026-09-01T00:00:00Z", null),
            makeRow("r2", "C1_data_accuracy", "given", "2026-09-02T00:00:00Z", null),
            makeRow("r3", "C2_release_approval", "given", "2026-09-02T00:00:00Z", null),
            makeRow("r4", "C3_revenue_split", "given", "2026-09-03T00:00:00Z", null),
          ]),
      ),
    ).rejects.toThrow(/more than one head/);
  });

  it("throws when signed_at is null", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async () =>
          okRes([
            makeRow("r1", "C1_data_accuracy", "given", null, null),
            makeRow("r2", "C2_release_approval", "given", "2026-09-02T00:00:00Z", null),
            makeRow("r3", "C3_revenue_split", "given", "2026-09-03T00:00:00Z", null),
          ]),
      ),
    ).rejects.toThrow(/null signed_at/);
  });

  it("yields identical result regardless of row shuffle order", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    const rows = [
      makeRow("r1", "C1_data_accuracy", "refused", "2026-09-01T00:00:00Z", null),
      makeRow("r2", "C1_data_accuracy", "given", "2026-09-02T00:00:00Z", "r1"),
      makeRow("r3", "C2_release_approval", "given", "2026-09-02T00:00:00Z", null),
      makeRow("r4", "C3_revenue_split", "given", "2026-09-03T00:00:00Z", null),
    ];
    // Permutation 1
    await expect(assertLaunchConsents(DB_ID, okFetchRes([...rows]))).resolves.toBeUndefined();
    // Permutation 2 (reversed)
    await expect(assertLaunchConsents(DB_ID, okFetchRes([...rows].reverse()))).resolves.toBeUndefined();
    // Permutation 3 (arbitrary shuffle)
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];
    await expect(assertLaunchConsents(DB_ID, okFetchRes(shuffled))).resolves.toBeUndefined();
  });

  it("throws on HTTP 500", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(assertLaunchConsents(DB_ID, async () => errRes(500))).rejects.toThrow(/HTTP 500/);
  });

  it("throws on network error", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(DB_ID, async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws when env vars are missing", async () => {
    stashEnv();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    await expect(assertLaunchConsents(DB_ID, async () => okRes([]))).rejects.toThrow(/launch blocked/);
  });
});

const paddleBlock = (): string =>
  primaryPaddle("cfg.json", {
    priceId: "pri_abc123",
    clientToken: "live_tok",
    productId: "prod_x",
    environment: "production",
  });

const GATED_SLOT =
  '<a class="buy pending" id="buy" href="#buy-link-pending" data-checkout-slot="primary" data-checkout-mode="gated">Gated</a>';

const stripAndSwapPrimary = (html: string): string =>
  swap(stripPaddleBlocks(html), "primary", GATED_SLOT);

describe("re-bake hygiene (strip markers + swap)", () => {
  it("paddle→paddle replaces the button and leaves exactly one marker block", () => {
    const before = `<html><body>\n${paddleBlock()}\n</body></html>`;
    const after = stripPaddleBlocks(before);
    const rebaked = swap(after, "primary", primaryPaddle("cfg.json", {
      priceId: "pri_new456",
      clientToken: "live_tok2",
      productId: "prod_x",
      environment: "production",
    }));
    expect(rebaked.match(/paddle-checkout:start/g)?.length).toBe(1);
    expect(rebaked.match(/paddle-checkout:end/g)?.length).toBe(1);
    expect(rebaked.match(/data-checkout-mode="paddle"/g)?.length).toBe(1);
    expect(rebaked).toContain("pri_new456");
  });

  it("paddle→gated leaves zero paddle markers/scripts and an <a> gated slot", () => {
    const before = `<html><body>\n${paddleBlock()}\n</body></html>`;
    const after = stripAndSwapPrimary(before);
    expect(after).not.toContain("paddle-checkout");
    expect(after).not.toContain("paddle.js");
    expect(after).not.toContain("<button");
    expect(after).toContain(GATED_SLOT);
  });

  it("pre-marker legacy output baked to gated leaves zero Paddle traces and an <a> gated slot", () => {
    const legacyPreMarkerHtml =
      `<html><head></head><body>\n` +
      `<button type="button" class="buy" id="buy" data-checkout-slot="primary" data-checkout-mode="paddle">Buy now</button>\n` +
      `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>\n` +
      `<script>(function(){\n` +
      `  window.Paddle.Initialize({ token: "test_123" });\n` +
      `  window.Paddle.Checkout.open({ items: [] });\n` +
      `})();</script>\n` +
      `</body></html>`;

    const after = stripAndSwapPrimary(legacyPreMarkerHtml);
    expect(after).not.toContain("cdn.paddle.com");
    expect(after).not.toContain("Paddle.Initialize");
    expect(after).not.toContain("Paddle.Checkout");
    expect(after).not.toContain("<button");
    expect(after).toContain(GATED_SLOT);
  });

  it("pre-marker legacy output baked to paddle leaves exactly one marker block", () => {
    const legacyPreMarkerHtml =
      `<html><head></head><body>\n` +
      `<button type="button" class="buy" id="buy" data-checkout-slot="primary" data-checkout-mode="paddle">Buy now</button>\n` +
      `<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>\n` +
      `<script>(function(){\n` +
      `  window.Paddle.Initialize({ token: "test_123" });\n` +
      `  window.Paddle.Checkout.open({ items: [] });\n` +
      `})();</script>\n` +
      `</body></html>`;

    const stripped = stripPaddleBlocks(legacyPreMarkerHtml);
    const rebaked = swap(stripped, "primary", primaryPaddle("cfg.json", {
      priceId: "pri_new789",
      clientToken: "live_tok3",
      productId: "prod_x",
      environment: "production",
    }));

    expect(rebaked.match(/paddle-checkout:start/g)?.length).toBe(1);
    expect(rebaked.match(/paddle-checkout:end/g)?.length).toBe(1);
    expect(rebaked.match(/data-checkout-mode="paddle"/g)?.length).toBe(1);
    expect(rebaked).toContain("pri_new789");
    expect(rebaked).not.toContain("test_123");
  });
});

describe("title precedence", () => {
  it("registry title wins when both book and inline title are present", () => {
    const registryTitle = loadBookIdentity().title;
    const res = loadProductConfig(undefined);
    expect(res.cfg.title).toBe(registryTitle);
    expect(res.cfg.title).not.toBe("Conflicting Inline Title");

    // Explicit test with conflicting inline title
    const resolvedTitle = resolveProductTitle({
      book: "books/duane.json",
      title: "Conflicting Inline Title",
    });
    expect(resolvedTitle).toBe(registryTitle);
    expect(resolvedTitle).not.toBe("Conflicting Inline Title");
  });

  it("uses inline title if no book is specified", () => {
    const resolvedTitle = resolveProductTitle({
      title: "Fallback Title",
    });
    expect(resolvedTitle).toBe("Fallback Title");
  });

  it("throws when neither book nor title is present", () => {
    expect(() => resolveProductTitle({})).toThrow(/no inline "title" either/);
  });
});

describe("paddleEnvironment", () => {
  it("accepts sandbox and production", () => {
    expect(paddleEnvironment("sandbox")).toBe("sandbox");
    expect(paddleEnvironment("production")).toBe("production");
  });
  it("throws on unset or typo", () => {
    expect(() => paddleEnvironment(undefined)).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => paddleEnvironment("staging")).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => paddleEnvironment("")).toThrow(/PADDLE_ENVIRONMENT/);
  });
});

describe("paddleTokenForEnv", () => {
  it("accepts live_ for production and test_ for sandbox", () => {
    expect(paddleTokenForEnv("live_abc", "production")).toBe("live_abc");
    expect(paddleTokenForEnv("test_abc", "sandbox")).toBe("test_abc");
  });
  it("throws on missing token", () => {
    expect(() => paddleTokenForEnv(undefined, "production")).toThrow(/NEXT_PUBLIC_PADDLE_CLIENT_TOKEN/);
  });
  it("throws on prefix disagreement (live_ + sandbox, test_ + production)", () => {
    expect(() => paddleTokenForEnv("live_abc", "sandbox")).toThrow(/live_|prefix/);
    expect(() => paddleTokenForEnv("test_abc", "production")).toThrow(/test_|prefix/);
  });
});

describe("storefront presentation & facts baking", () => {
  it("loads title, subtitle, and author from book registry in loadProductConfig", () => {
    const { cfg } = loadProductConfig(undefined);
    const book = loadBookIdentity();
    expect(cfg.title).toBe(book.title);
    expect(cfg.subtitle).toBe(book.subtitle);
    expect(cfg.author).toBe(book.author);
    expect(cfg.price_usd).toBe(39);
  });

  it("bakes title, subtitle, author, and price into storefront HTML", () => {
    const rawHtml = [
      `<!doctype html><html><head>`,
      `<title>Old Title</title>`,
      `<meta property="og:title" content="Old Title">`,
      `<meta name="description" content="A guide. Digital PDF, $19.">`,
      `</head><body>`,
      `<h1>Old Title</h1>`,
      `<p class="byline">A creator-collaboration publication &middot; with <b>Someone Else</b></p>`,
      `<p class="price">$19 <small>USD &middot; one-time</small></p>`,
      `</body></html>`,
    ].join("\n");

    const book = loadBookIdentity();
    const facts: Facts = {
      title: book.title,
      subtitle: book.subtitle,
      author: book.author,
      price_usd: 39,
    };

    const baked = bakeFacts(rawHtml, facts, "site/c/retirearly500k/500k-playbook/index.html");
    expect(baked).toContain(`<h1>${book.title.replace(/'/g, "&#39;")}</h1>`);
    expect(baked).toContain(book.subtitle);
    expect(baked).toContain(`with <b>${book.author}</b>`);
    expect(baked).toContain(`<p class="price">$39 <small>USD &middot; one-time</small></p>`);
    expect(baked).toContain(`<title>${book.title.replace(/'/g, "&#39;")}</title>`);
  });

  it("updates existing subtitle if subtitle paragraph already exists", () => {
    const rawHtml = [
      `<h1>Title</h1>`,
      `<p class="subtitle">Old Subtitle</p>`,
      `<p class="price">$10</p>`,
    ].join("\n");

    const facts: Facts = {
      title: "New Title",
      subtitle: "New Subtitle",
      author: "Duane",
      price_usd: 39,
    };

    const baked = bakeFacts(rawHtml, facts, "page.html");
    expect(baked).toContain(`<p class="subtitle">New Subtitle</p>`);
    expect(baked).not.toContain("Old Subtitle");
  });
});
