import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCheckoutProduct } from "../../../../src/components/storefront/storefront";
import { ATTRIBUTION_KEYS } from "../../../../src/lib/attribution";
import { paddleOverlayConfig } from "../../../../src/lib/paddle-overlay-server";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import CheckoutPage from "../page";

// "server-only" throws outside the react-server condition; stub it so this file loads under any runner (as the sibling page tests do).
vi.mock("server-only", () => ({}));

// Money-path branches of the pay-domain checkout page: a live product renders the single-hop
// BuyerEmailStep POST form, a gated product gets the disabled notice and no form, and an
// unknown product must not render a checkout at all.

vi.mock("../../../../src/components/storefront/storefront", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/components/storefront/storefront")>();
  return {
    ...actual,
    NOINDEX: { index: false },
    StorefrontFooter: "StorefrontFooter",
    fetchCheckoutProduct: vi.fn(),
    isWorkingTitle: () => false,
    priceOf: () => 39,
  };
});

vi.mock("../../../../src/components/storefront/buyer-email-step", () => ({ BuyerEmailStep: "BuyerEmailStep" }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | Node[];

// Visit every React element in the rendered tree (elements are plain objects with type and props).
function walk(node: Node, visit: (el: { type?: unknown; props: Record<string, unknown> }) => void): void {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  const el = node as { type?: unknown; props: Record<string, unknown> };
  visit(el);
  walk(el.props.children as Node, visit);
}

function product(over: Record<string, unknown> = {}, extra: { displayName?: string; isHouse?: boolean; railProvider?: string | null } = {}) {
  return {
    creator: { handle: "ada", display_name: extra.displayName ?? "Ada", is_house: extra.isHouse ?? false },
    railProvider: "railProvider" in extra ? extra.railProvider : "paddle",
    product: {
      id: "p1",
      title: "Book",
      slug: "book",
      description: null,
      currency: "USD",
      checkout_mode: "live",
      paddle_price_id: null,
      price_usd: "39.00",
      ...over,
    },
  };
}

const render = (productId: string, sp: Record<string, string> = {}) =>
  CheckoutPage({
    params: Promise.resolve({ productId }),
    searchParams: Promise.resolve(sp),
  });

beforeEach(() => {
  vi.mocked(fetchCheckoutProduct).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkout page: single-hop BuyerEmailStep branch", () => {
  it("live product renders BuyerEmailStep posting to /api/billing/checkout with productId", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product() as never);
    const tree = await render("p1");
    const steps: Array<Record<string, unknown>> = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") steps.push(el.props);
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: "/api/billing/checkout",
      productId: "p1",
      initialAttribution: {},
    });
  });

  it("forwards attribution parameters from searchParams into initialAttribution", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product() as never);
    const key = Object.keys(ATTRIBUTION_KEYS)[0];
    const tree = await render("p1", { [key]: "abc", buyer_email: "ignored@example.com" });
    const steps: Array<Record<string, unknown>> = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") steps.push(el.props);
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].initialAttribution).toEqual({ [key]: "abc" });
  });

  it("drops empty attribution values rather than forwarding them", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product() as never);
    const key = Object.keys(ATTRIBUTION_KEYS)[0];
    const tree = await render("p1", { [key]: "" });
    const steps: Array<Record<string, unknown>> = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") steps.push(el.props);
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].initialAttribution).toEqual({});
  });
});

describe("checkout page: buyer legal links visibility (LV-03)", () => {
  function footerProps(tree: unknown): Array<Record<string, unknown>> {
    const found: Array<Record<string, unknown>> = [];
    walk(tree as Node, (el) => {
      if (el.type === "StorefrontFooter") found.push(el.props);
    });
    return found;
  }

  it("shows the buyer legal links on a gated (draft) product by default (always_show_buyer_legal=true)", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: "gated" }) as never);
    const footers = footerProps(await render("p1"));
    expect(footers).toHaveLength(1);
    expect(footers[0].showBuyerLegal).toBe(true);
  });

  it("hides the buyer legal links on a gated product only when always_show_buyer_legal is false", async () => {
    const orig = GLOBAL.storefront.always_show_buyer_legal;
    GLOBAL.storefront.always_show_buyer_legal = false;
    try {
      vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: "gated" }) as never);
      const footers = footerProps(await render("p1"));
      expect(footers).toHaveLength(1);
      expect(footers[0].showBuyerLegal).toBe(false);
    } finally {
      GLOBAL.storefront.always_show_buyer_legal = orig;
    }
  });

  it("shows the buyer legal links on a live product", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: "live" }) as never);
    const footers = footerProps(await render("p1"));
    expect(footers).toHaveLength(1);
    expect(footers[0].showBuyerLegal).toBe(true);
  });
});

describe("checkout page: gated branch", () => {
  it("gated product renders no BuyerEmailStep and shows the disabled notice", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: "gated" }) as never);
    const tree = await render("p1");
    let emailSteps = 0;
    let gatedNotices = 0;
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") emailSteps += 1;
      if (el.props["data-checkout-mode"] === "gated") gatedNotices += 1;
    });
    expect(emailSteps).toBe(0);
    expect(gatedNotices).toBe(1);
  });

  it("a null checkout_mode also renders no BuyerEmailStep", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: null }) as never);
    const tree = await render("p1");
    let emailSteps = 0;
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") emailSteps += 1;
    });
    expect(emailSteps).toBe(0);
  });
});

describe("checkout page: unpriced product (price_usd null) has no buy form", () => {
  it.each([
    ["null", null],
    ["blank", "  "],
  ])("live product with price_usd %s renders no BuyerEmailStep and the unpriced non-purchasable notice", async (_label, price_usd) => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ price_usd }) as never);
    const tree = await render("p1");
    let emailSteps = 0;
    let unpriced = 0;
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") emailSteps += 1;
      if (el.props["data-checkout-mode"] === "unpriced") unpriced += 1;
    });
    expect(emailSteps).toBe(0);
    expect(unpriced).toBe(1);
  });

  it("live product with a set price keeps the BuyerEmailStep form (control)", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ price_usd: "39.00" }) as never);
    const tree = await render("p1");
    let emailSteps = 0;
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") emailSteps += 1;
    });
    expect(emailSteps).toBe(1);
  });
});

describe("checkout page: paddle overlay error log is gated to Paddle-overlay checkouts", () => {
  const OVERLAY_LOG = "[checkout] paddle overlay unavailable";
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const overlayLogs = () => errorSpy.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith(OVERLAY_LOG)).length;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("a live product on a non-Paddle rail never logs the Paddle overlay error", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ paddle_price_id: "pri_1" }, { railProvider: "creem" }) as never);
    await render("p1");
    expect(overlayLogs()).toBe(0);
  });

  it("a Paddle rail with no paddle_price_id never logs the Paddle overlay error", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ paddle_price_id: null }, { railProvider: "paddle" }) as never);
    await render("p1");
    expect(overlayLogs()).toBe(0);
  });

  it("a live Paddle checkout logs the overlay error exactly when the overlay config is not usable", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ paddle_price_id: "pri_1" }, { railProvider: "paddle" }) as never);
    await render("p1");
    expect(overlayLogs()).toBe(paddleOverlayConfig().ok ? 0 : 1);
  });
});

describe("checkout page: unknown product", () => {
  it("does not render a checkout when the product is not found", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(null as never);
    await expect(render("missing")).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});

describe("checkout page: Paddle Option A client config, MoR provider line, and house/creator sentence", () => {
  it("passes paddleClient when token, environment, paddle_price_id, and paddle rail match", async () => {
    const o = GLOBAL.payments.paddle.overlay;
    vi.stubEnv(o.client_token_env, "live_tok_123");
    vi.stubEnv(o.environment_env, "production");
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ paddle_price_id: "pri_live_1" }) as never);
    const tree = await render("p1");
    const steps: Array<Record<string, unknown>> = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") steps.push(el.props);
    });
    expect(steps[0].paddleClient).toEqual({ token: "live_tok_123", environment: "production" });
  });

  it("logs an environment mismatch and sets paddleClient to null when the overlay is sandbox but the product is live", async () => {
    const o = GLOBAL.payments.paddle.overlay;
    vi.stubEnv(o.client_token_env, "sandbox_tok_123");
    vi.stubEnv(o.environment_env, "sandbox");
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ paddle_price_id: "pri_live_1" }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tree = await render("p1");
      const steps: Array<Record<string, unknown>> = [];
      walk(tree as unknown as Node, (el) => {
        if (el.type === "BuyerEmailStep") steps.push(el.props);
      });
      expect(steps[0].paddleClient).toBeNull();
      const mismatchLogs = errorSpy.mock.calls.filter((args) => String(args[0]).includes("does not match checkout mode"));
      expect(mismatchLogs).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    ["an unpriced live Paddle product", product({ price_usd: null, paddle_price_id: "pri_live_1" }, { railProvider: "paddle" })],
    ["a Paddle rail with no paddle_price_id", product({ paddle_price_id: null }, { railProvider: "paddle" })],
    ["a Creem rail", product({ paddle_price_id: "pri_live_1" }, { railProvider: "creem" })],
  ])("never logs the overlay environment mismatch for %s", async (_label, fixture) => {
    const o = GLOBAL.payments.paddle.overlay;
    vi.stubEnv(o.client_token_env, "sandbox_tok_123");
    vi.stubEnv(o.environment_env, "sandbox");
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(fixture as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await render("p1");
      const mismatchLogs = errorSpy.mock.calls.filter((args) => String(args[0]).includes("does not match checkout mode"));
      expect(mismatchLogs).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sets paddleClient to null when rail is non-paddle or paddle_price_id is missing", async () => {
    const o = GLOBAL.payments.paddle.overlay;
    vi.stubEnv(o.client_token_env, "live_tok_123");
    vi.stubEnv(o.environment_env, "production");

    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ paddle_price_id: "pri_1" }, { railProvider: "creem" }) as never);
    let steps: Array<Record<string, unknown>> = [];
    walk((await render("p1")) as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") steps.push(el.props);
    });
    expect(steps[0].paddleClient).toBeNull();

    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ paddle_price_id: null }, { railProvider: "paddle" }) as never);
    steps = [];
    walk((await render("p1")) as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") steps.push(el.props);
    });
    expect(steps[0].paddleClient).toBeNull();
  });

  it("names only the rail provider on the Merchant of Record line (never 'and others as enabled')", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({}, { railProvider: "paddle" }) as never);
    const paddleHtml = renderToStaticMarkup(await render("p1"));
    expect(paddleHtml).toContain("Your order is processed by Paddle.com, which acts as Merchant of Record.");
    expect(paddleHtml).not.toContain("and others as enabled");

    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({}, { railProvider: "creem" }) as never);
    const creemHtml = renderToStaticMarkup(await render("p1"));
    expect(creemHtml).toContain("Your order is processed by Creem, which acts as Merchant of Record.");
    expect(creemHtml).not.toContain("Paddle.com");
  });

  it("with no active rail the page names no merchant of record and no default provider", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({}, { railProvider: null }) as never);
    const html = renderToStaticMarkup(await render("p1"));
    expect(html).not.toContain("Merchant of Record");
    expect(html).not.toContain("Paddle.com");
    expect(html).not.toContain("Creem");
  });

  it("renders 'Published by ExpanPress' for house products and 'A creator-collaboration publication with <creator>' without middle dot", async () => {
    const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({}, { displayName: GLOBAL.storefront.brand_name, isHouse: true }) as never);
    const houseHtml = renderToStaticMarkup(await render("p1"));
    expect(stripTags(houseHtml)).toContain("Published by ExpanPress");
    expect(houseHtml).not.toContain("creator-collaboration");

    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({}, { displayName: "Ada" }) as never);
    const creatorHtml = renderToStaticMarkup(await render("p1"));
    expect(stripTags(creatorHtml)).toContain("A creator-collaboration publication with Ada");
    expect(stripTags(creatorHtml)).not.toContain("publication · with");
  });
});
