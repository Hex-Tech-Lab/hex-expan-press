// Pairwise (PICT) test for the checkout page's active-rail count, rail provider and Paddle overlay (option B, fail closed on ambiguity).
// Model: docs/testing/pairwise/checkout_page_rails.model.txt
// Rows:  docs/testing/pairwise/checkout_page_rails.rows.tsv (every generated row is asserted below)
// Expected outcomes come from expectedOutcome() below, written from the specification, not from page.tsx.
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCheckoutProduct } from "../../../../src/components/storefront/storefront";
import { GLOBAL } from "../../../../../payments/src/settings_registry";
import CheckoutPage from "../page";

vi.mock("server-only", () => ({}));

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

const ROWS_PATH = fileURLToPath(new URL("../../../../../docs/testing/pairwise/checkout_page_rails.rows.tsv", import.meta.url));
const EXPECTED_ROW_COUNT = 5;
const OVERLAY_LOG = "[checkout] paddle overlay unavailable";
const MULTI_RAIL_WARN = "[checkout] more than one active rail";
const TOKEN = "live_tok_123";
const ENVIRONMENT = "production";

type Rails = "one" | "two";
type Provider = "paddle" | "creem";
type Overlay = "usable" | "unusable";
type Row = { rails: Rails; provider: Provider; overlay: Overlay };

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | Node[];

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

function product(provider: Provider, rails: Rails) {
  return {
    creator: { handle: "ada", display_name: "Ada", is_house: false },
    railProvider: provider,
    activeRailCount: rails === "one" ? 1 : 2,
    product: {
      id: "p1",
      title: "Book",
      slug: "book",
      description: null,
      currency: "USD",
      checkout_mode: "live",
      paddle_price_id: "pri_live_1",
      price_usd: "39.00",
      store_product_id: "sp_1",
      working_note: null,
      disclaimers: null,
      inside: null,
    },
  };
}

const render = (productId: string) =>
  CheckoutPage({
    params: Promise.resolve({ productId }),
    searchParams: Promise.resolve({}),
  });

// Reads the committed PICT rows (header first) into typed rows.
function loadRows(): Row[] {
  const [header, ...lines] = readFileSync(ROWS_PATH, "utf8").trim().split("\n");
  const cols = header.split("\t");
  return lines.map((line) => {
    const cells = line.split("\t");
    const r = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
    return { rails: r.rails as Rails, provider: r.provider as Provider, overlay: r.overlay as Overlay };
  });
}

// Oracle written from the specification (not from page.tsx):
//  - two active rails: no merchant of record, no overlay client, one fail-closed warn, no overlay error log;
//  - one rail, creem: merchant of record "Creem", no overlay client, no overlay log;
//  - one rail, paddle, overlay usable: merchant of record "Paddle.com", overlay client passed, no logs;
//  - one rail, paddle, overlay unusable: merchant of record "Paddle.com", no overlay client, one overlay-unavailable log.
function expectedOutcome(row: Row) {
  if (row.rails === "two") {
    return { morName: null, paddleClient: null, multiRailWarns: 1, overlayLogs: 0 };
  }
  const morName = row.provider === "paddle" ? "Paddle.com" : "Creem";
  if (row.provider === "creem") return { morName, paddleClient: null, multiRailWarns: 0, overlayLogs: 0 };
  if (row.overlay === "usable") {
    return { morName, paddleClient: { token: TOKEN, environment: ENVIRONMENT }, multiRailWarns: 0, overlayLogs: 0 };
  }
  return { morName, paddleClient: null, multiRailWarns: 0, overlayLogs: 1 };
}

const ROWS = loadRows();

describe("checkout page: active rail count, provider and overlay (PICT pairwise)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it(`the committed rows match the generated count (${EXPECTED_ROW_COUNT})`, () => {
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });

  it.each(ROWS.map((r) => [`${r.rails} rail(s), ${r.provider}, overlay ${r.overlay}`, r] as const))("%s", async (_label, row) => {
    const o = GLOBAL.payments.paddle.overlay;
    vi.stubEnv(o.client_token_env, row.overlay === "usable" ? TOKEN : "");
    vi.stubEnv(o.environment_env, ENVIRONMENT);
    vi.mocked(fetchCheckoutProduct).mockResolvedValue(product(row.provider, row.rails) as never);

    const tree = await render("p1");
    const html = renderToStaticMarkup(tree);
    const steps: Array<Record<string, unknown>> = [];
    walk(tree as unknown as Node, (el) => {
      if (el.type === "BuyerEmailStep") steps.push(el.props);
    });

    const want = expectedOutcome(row);
    if (want.morName === null) {
      expect(html).not.toContain("Merchant of Record");
    } else {
      expect(html).toContain(`Your order is processed by ${want.morName}, which acts as Merchant of Record.`);
    }
    expect(steps[0].paddleClient).toEqual(want.paddleClient);
    const multiWarns = warnSpy.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith(MULTI_RAIL_WARN));
    expect(multiWarns).toHaveLength(want.multiRailWarns);
    const overlayErrors = errorSpy.mock.calls.filter((args: unknown[]) => String(args[0]).startsWith(OVERLAY_LOG));
    expect(overlayErrors).toHaveLength(want.overlayLogs);
  });
});
