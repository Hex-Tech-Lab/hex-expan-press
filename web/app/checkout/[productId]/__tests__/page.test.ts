import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchCheckoutProduct } from "../../../../src/components/storefront/storefront";
import { ATTRIBUTION_KEYS } from "../../../../src/lib/attribution";
import CheckoutPage from "../page";

// Money-path branches of the pay-domain checkout page: a live product gets the buy link, a gated product
// gets the disabled notice and no link, and an unknown product must not render a checkout at all.

vi.mock("../../../../src/components/storefront/storefront", () => ({
  NOINDEX: { index: false },
  StorefrontFooter: () => null,
  fetchCheckoutProduct: vi.fn(),
  isWorkingTitle: () => false,
  priceOf: () => "39",
}));

vi.mock("../../../../src/components/storefront/buy-link", () => ({ BuyLink: "BuyLink" }));

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
      composite_slug: "book",
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

describe("checkout page: buy branch", () => {
  it("live product renders the buy link to the checkout route with the product id", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product() as never);
    const tree = await render("p1");
    const links: string[] = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyLink") links.push(String(el.props.href));
    });
    expect(links).toEqual(["/api/billing/checkout?product=p1"]);
  });

  it("forwards an attribution parameter to the buy link", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product() as never);
    const key = Object.keys(ATTRIBUTION_KEYS)[0];
    const tree = await render("p1", { [key]: "abc" });
    const hrefs: string[] = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyLink") hrefs.push(String(el.props.href));
    });
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toContain(`${key}=abc`);
  });

  it("drops empty attribution values rather than forwarding them", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product() as never);
    const key = Object.keys(ATTRIBUTION_KEYS)[0];
    const tree = await render("p1", { [key]: "" });
    const hrefs: string[] = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyLink") hrefs.push(String(el.props.href));
    });
    expect(hrefs).toEqual(["/api/billing/checkout?product=p1"]);
  });
});

describe("checkout page: gated branch", () => {
  it("gated product renders no buy link and shows the disabled notice", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: "gated" }) as never);
    const tree = await render("p1");
    let buyLinks = 0;
    let gatedNotices = 0;
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyLink") buyLinks += 1;
      if (typeof el.props.className === "string" && el.props.className.includes("buybtn-gated")) gatedNotices += 1;
    });
    expect(buyLinks).toBe(0);
    expect(gatedNotices).toBe(1);
  });

  it("a null checkout_mode also renders no buy link", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product({ checkout_mode: null }) as never);
    const tree = await render("p1");
    let buyLinks = 0;
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyLink") buyLinks += 1;
    });
    expect(buyLinks).toBe(0);
  });
});

describe("checkout page: unknown product", () => {
  it("does not render a checkout when the product is not found", async () => {
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(null as never);
    await expect(render("missing")).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});
