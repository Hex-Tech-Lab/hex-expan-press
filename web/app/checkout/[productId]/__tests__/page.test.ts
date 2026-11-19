import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchCheckoutProduct } from "../../../../src/components/storefront/storefront";
import { ATTRIBUTION_KEYS } from "../../../../src/lib/attribution";
import CheckoutPage from "../page";

// Money-path branches of the pay-domain checkout page: a live product renders the single-hop
// BuyerEmailStep POST form, a gated product gets the disabled notice and no form, and an
// unknown product must not render a checkout at all.

vi.mock("../../../../src/components/storefront/storefront", () => ({
  NOINDEX: { index: false },
  StorefrontFooter: "StorefrontFooter",
  fetchCheckoutProduct: vi.fn(),
  isWorkingTitle: () => false,
  priceOf: () => 39,
}));

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

function product(over: Record<string, unknown> = {}) {
  return {
    creator: { display_name: "Ada" },
    product: {
      id: "p1",
      title: "Book",
      slug: "book",
      description: null,
      currency: "USD",
      checkout_mode: "live",
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

describe("checkout page: buyer legal links follow the checkout mode", () => {
  function footerProps(tree: unknown): Array<Record<string, unknown>> {
    const found: Array<Record<string, unknown>> = [];
    walk(tree as Node, (el) => {
      if (el.type === "StorefrontFooter") found.push(el.props);
    });
    return found;
  }

  it("hides the buyer legal links on a gated (draft) product", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: "gated" }) as never);
    const footers = footerProps(await render("p1"));
    expect(footers).toHaveLength(1);
    expect(footers[0].showBuyerLegal).toBe(false);
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
