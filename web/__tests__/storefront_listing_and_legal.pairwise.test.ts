// Pairwise (PICT) test for storefront listing filter and buyer legal-links visibility.
// Model: docs/testing/pairwise/storefront_listing_and_legal.model.txt
// Rows:  docs/testing/pairwise/storefront_listing_and_legal.rows.tsv (16 PICT rows, every row asserted below)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";

vi.mock("server-only", () => ({}));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const mockStore = vi.hoisted(() => ({
  checkoutMode: "live" as string | null,
  isSample: false,
  sandboxOpen: false,
}));

vi.mock("../src/lib/sandbox-checkout", () => ({
  sandboxAllowed: () => mockStore.sandboxOpen,
}));

vi.mock("../src/components/storefront/storefront", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/storefront/storefront")>();
  return {
    ...actual,
    fetchStoreProduct: vi.fn(async () => ({
      creator: {
        handle: "expanpress_house",
        display_name: "ExpanPress",
        platform_handles: null,
        bio: null,
        photo: null,
        products: [],
      },
      product: {
        id: "00000000-0000-4000-8000-0000000000b3",
        store_product_id: "prod_pw",
        slug: "pw_book",
        title: "Pairwise Book",
        price_usd: "19",
        currency: "USD",
        working_note: null,
        description: "Pairwise test book.",
        disclaimers: [],
        checkout_mode: mockStore.checkoutMode,
        is_sample: mockStore.isSample,
        inside: null,
        preview_pdf: null,
        overview: null,
      },
      origin: "https://expanpress.com",
    })),
    fetchCheckoutProduct: vi.fn(async () => ({
      creator: { handle: "expanpress_house", display_name: "ExpanPress" },
      usableRails: [{ provider: "paddle", weight: 100, checkout_url: "https://buy.paddle.com/pw-rail" }],
      product: {
        id: "00000000-0000-4000-8000-0000000000b3",
        store_product_id: "prod_pw",
        slug: "pw_book",
        title: "Pairwise Book",
        price_usd: "19",
        currency: "USD",
        working_note: null,
        description: "Pairwise test book.",
        disclaimers: [],
        checkout_mode: mockStore.checkoutMode,
        paddle_price_id: null,
        inside: null,
      },
    })),
  };
});

import {
  allowedStorefrontCheckoutModes,
  isVisibleStorefrontProduct,
} from "../src/components/storefront/storefront";
import StoreProductPage from "../app/books/[handle]/[product]/page";
import CheckoutPage from "../app/checkout/[productId]/page";

const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = fileURLToPath(
  new URL("../../docs/testing/pairwise/storefront_listing_and_legal.model.txt", import.meta.url),
);
const ROWS_PATH = fileURLToPath(
  new URL("../../docs/testing/pairwise/storefront_listing_and_legal.rows.tsv", import.meta.url),
);
const EXPECTED_ROW_COUNT = 16;

interface ListingLegalRow {
  rowNum: number;
  show_non_live_samples: "true" | "false";
  allowed_modes: "gated_only" | "gated_and_sandbox" | "empty";
  is_sample: "true" | "false";
  checkout_mode: "live" | "gated" | "sandbox" | "paddle" | "null";
  always_show_buyer_legal: "true" | "false";
  buyer_surface: "product_page" | "checkout_page";
  sandboxOpen: "true" | "false";
}

function parseRows(tsv: string): ListingLegalRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as ListingLegalRow;
  });
}

const MODES_BY_TOKEN: Record<ListingLegalRow["allowed_modes"], string[]> = {
  gated_only: ["gated"],
  gated_and_sandbox: ["gated", "sandbox"],
  empty: [],
};

function oracleListingVisible(row: ListingLegalRow): boolean {
  if (row.checkout_mode === "live") return true;
  if (row.checkout_mode === "sandbox" && row.sandboxOpen === "true") return true;
  if (row.show_non_live_samples !== "true") return false;
  if (row.is_sample !== "true") return false;
  return MODES_BY_TOKEN[row.allowed_modes].includes(row.checkout_mode);
}

function oracleLegalVisible(row: ListingLegalRow): boolean {
  if (row.always_show_buyer_legal === "true") return true;
  return row.checkout_mode === "live" || (row.checkout_mode === "sandbox" && row.sandboxOpen === "true");
}

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);
const origAlwaysShowBuyerLegal = GLOBAL.storefront.always_show_buyer_legal;

afterEach(() => {
  GLOBAL.storefront.always_show_buyer_legal = origAlwaysShowBuyerLegal;
  mockStore.sandboxOpen = false;
});

describe("storefront listing filter & legal-links visibility: PICT pairwise", () => {
  it("checked-in rows TSV matches /usr/local/bin/pict output (no model drift)", () => {
    const pictMissing = !existsSync(PICT_BIN);
    if (pictMissing) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const generated = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8" }).trim();
    expect(generated).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });

  it.each(ROWS)(
    "row $rowNum: show=$show_non_live_samples modes=$allowed_modes sample=$is_sample mode=$checkout_mode alwaysLegal=$always_show_buyer_legal surface=$buyer_surface sandboxOpen=$sandboxOpen",
    async (row) => {
      const storefrontCfg = {
        show_non_live_samples: row.show_non_live_samples === "true",
        allowed_non_live_sample_modes: MODES_BY_TOKEN[row.allowed_modes],
      };
      const checkoutMode = row.checkout_mode === "null" ? null : row.checkout_mode;
      const isSample = row.is_sample === "true";
      const sandboxOpen = row.sandboxOpen === "true";

      // 1. Listing visibility oracle vs storefront helpers (third argument sandboxOpen + second argument sandboxOpen)
      const wantListed = oracleListingVisible(row);
      expect(isVisibleStorefrontProduct({ checkout_mode: checkoutMode, is_sample: isSample }, storefrontCfg, sandboxOpen)).toBe(
        wantListed,
      );

      const allowedQueryModes = allowedStorefrontCheckoutModes(storefrontCfg, sandboxOpen);
      const expectedQueryModes = new Set<string>(["live"]);
      if (sandboxOpen) expectedQueryModes.add("sandbox");
      if (row.show_non_live_samples === "true") {
        for (const m of MODES_BY_TOKEN[row.allowed_modes]) {
          expectedQueryModes.add(m);
        }
      }
      expect(new Set(allowedQueryModes)).toEqual(expectedQueryModes);
      expect(allowedQueryModes).toHaveLength(expectedQueryModes.size);

      // 2. Buyer legal-links visibility oracle vs rendered product/checkout page
      GLOBAL.storefront.always_show_buyer_legal = row.always_show_buyer_legal === "true";
      mockStore.checkoutMode = checkoutMode;
      mockStore.isSample = isSample;
      mockStore.sandboxOpen = sandboxOpen;
      const wantLegal = oracleLegalVisible(row);

      const tree =
        row.buyer_surface === "product_page"
          ? await StoreProductPage({
              params: Promise.resolve({ handle: "expanpress_house", product: "pw_book" }),
            })
          : await CheckoutPage({
              params: Promise.resolve({ productId: "00000000-0000-4000-8000-0000000000b3" }),
              searchParams: Promise.resolve({}),
            });
      const html = renderToStaticMarkup(tree);
      for (const href of [
        "/books/legal/privacy.html",
        "/books/legal/terms.html",
        "/books/legal/refund-policy.html",
      ]) {
        if (wantLegal) {
          expect(html, `row ${row.rowNum} should show ${href}`).toContain(href);
        } else {
          expect(html, `row ${row.rowNum} should hide ${href}`).not.toContain(href);
        }
      }
      expect(html).toContain(GLOBAL.email.support);
    },
  );
});
