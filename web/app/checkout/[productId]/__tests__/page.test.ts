import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCheckoutProduct } from "../../../../src/components/storefront/storefront";
import { ATTRIBUTION_KEYS } from "../../../../src/lib/attribution";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import CheckoutPage from "../page";

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

function product(over: Record<string, unknown> = {}, extra: { displayName?: string; railProvider?: string | null } = {}) {
  return {
    creator: { handle: "ada", display_name: extra.displayName ?? "Ada" },
    railProvider: "railProvider" in extra ? extra.railProvider : "paddle",
    product: {
      id: "p1",
      title: "Book",
      slug: "book",
      description: null,
      currency: "USD",
      checkout_mode: "live",
      paddle_price_id: null,
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

  it("renders 'Published by ExpanPress' for house products and 'A creator-collaboration publication with <creator>' without middle dot", async () => {
    const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({}, { displayName: GLOBAL.storefront.brand_name }) as never);
    const houseHtml = renderToStaticMarkup(await render("p1"));
    expect(stripTags(houseHtml)).toContain("Published by ExpanPress");
    expect(houseHtml).not.toContain("creator-collaboration");

    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({}, { displayName: "Ada" }) as never);
    const creatorHtml = renderToStaticMarkup(await render("p1"));
    expect(stripTags(creatorHtml)).toContain("A creator-collaboration publication with Ada");
    expect(stripTags(creatorHtml)).not.toContain("publication · with");
  });
});
