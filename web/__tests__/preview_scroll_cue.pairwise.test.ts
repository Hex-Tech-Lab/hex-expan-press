// @vitest-environment jsdom
// PICT pairwise test for the product-page preview scroll arrow (PreviewScrollCue + product page gate).
// Model: docs/testing/pairwise/preview_scroll_cue.model.txt
// Rows:  docs/testing/pairwise/preview_scroll_cue.rows.tsv (7 generated PICT rows)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("server-only", () => ({}));
vi.mock("../../payments/src/supabase_admin", () => ({ getSupabaseAdmin: vi.fn(async () => null) }));

const productMock = vi.hoisted(() => ({
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
    store_product_id: "prod_pw_cue",
    slug: "pw_cue_book",
    title: "Pairwise Cue Book",
    price_usd: "19",
    currency: "USD",
    working_note: null,
    description: "Pairwise arrow test.",
    disclaimers: [],
    checkout_mode: "live",
    inside: null,
    preview_pdf: null as string | null,
    overview: null,
  },
  origin: "https://expanpress.com",
}));

vi.mock("../src/components/storefront/storefront", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/storefront/storefront")>()),
  fetchStoreProduct: vi.fn(async () => productMock),
}));

const motionState = vi.hoisted(() => ({
  framerReduced: false,
  propsLog: [] as Array<{ animate: unknown; transition: unknown }>,
}));

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    useReducedMotion: () => motionState.framerReduced,
    motion: {
      ...actual.motion,
      span: (props: React.HTMLAttributes<HTMLSpanElement> & { animate?: unknown; transition?: unknown; initial?: unknown }) => {
        const { children, animate, transition, ...rest } = props;
        delete (rest as { initial?: unknown }).initial;
        motionState.propsLog.push({ animate, transition });
        return React.createElement("span", rest, children);
      },
    },
  };
});

import StoreProductPage from "../app/books/[handle]/[product]/page";
import { PreviewScrollCue } from "../src/components/storefront/preview-scroll-cue";

const MODEL_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/preview_scroll_cue.model.txt");
const ROWS_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/preview_scroll_cue.rows.tsv");
const PICT_BIN = "/usr/local/bin/pict";
const EXPECTED_ROW_COUNT = 7;

interface CueRow {
  rowNum: number;
  preview_pdf: "present" | "absent";
  target_exists: "yes" | "no";
  match_media_supported: "yes" | "no";
  framer_reduced: "true" | "false";
  media_reduced: "true" | "false";
  interaction: "click" | "none";
}

function parseRows(tsv: string): CueRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as CueRow;
  });
}

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

describe("preview_scroll_cue: PICT pairwise artifact integrity", () => {
  it("saved rows file matches live PICT output and covers all generated rows", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const liveOut = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8" }).trim();
    expect(liveOut).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });
});

describe(`preview_scroll_cue: ${EXPECTED_ROW_COUNT} PICT pairwise rows`, () => {
  beforeEach(() => {
    motionState.propsLog.length = 0;
    motionState.framerReduced = false;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(ROWS)(
    "row #$rowNum: pdf=$preview_pdf | target=$target_exists | matchMedia=$match_media_supported | framerReduced=$framer_reduced | mediaReduced=$media_reduced | interaction=$interaction",
    async (row) => {
      const layout = DEFAULT_GLOBAL.storefront.product_layout;
      productMock.product.preview_pdf = row.preview_pdf === "present" ? "/books/previews/pw.pdf" : null;

      // 1. Product page render gate
      const tree = await StoreProductPage({
        params: Promise.resolve({ handle: "expanpress_house", product: "pw_cue_book" }),
      });
      const ssrHtml = renderToStaticMarkup(tree);
      if (row.preview_pdf === "absent") {
        expect(ssrHtml).not.toContain('data-testid="preview-scroll-cue"');
        return;
      }
      expect(ssrHtml).toContain('data-testid="preview-scroll-cue"');

      // 2. Interactive PreviewScrollCue component behavior
      motionState.framerReduced = row.framer_reduced === "true";
      if (row.match_media_supported === "yes") {
        Object.defineProperty(window, "matchMedia", {
          writable: true,
          configurable: true,
          value: vi.fn().mockImplementation((query: string) => ({
            matches: query === "(prefers-reduced-motion: reduce)" && row.media_reduced === "true",
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          })),
        });
      } else {
        Object.defineProperty(window, "matchMedia", {
          writable: true,
          configurable: true,
          value: undefined,
        });
      }

      container = document.createElement("div");
      const scrollIntoView = vi.fn();
      if (row.target_exists === "yes") {
        const target = document.createElement("section");
        target.id = layout.preview_section_id;
        target.scrollIntoView = scrollIntoView;
        container.appendChild(target);
      }
      const host = document.createElement("div");
      container.appendChild(host);
      document.body.appendChild(container);

      root = createRoot(host);
      await act(async () => {
        root!.render(
          React.createElement(PreviewScrollCue, {
            targetId: layout.preview_section_id,
            label: layout.preview_cue_label,
            bounceDistancePx: layout.cue_bounce_distance_px,
            bounceDurationS: layout.cue_bounce_duration_s,
            bounceRepeatDelayS: layout.cue_bounce_repeat_delay_s,
          }),
        );
      });

      const expectReduced =
        row.framer_reduced === "true" ||
        (row.match_media_supported === "yes" && row.media_reduced === "true");
      const latestMotion = motionState.propsLog[motionState.propsLog.length - 1];
      if (expectReduced) {
        expect(latestMotion?.animate).toEqual({ y: 0 });
        expect(latestMotion?.transition).toEqual({ duration: 0 });
      } else {
        expect(latestMotion?.animate).toEqual({ y: [0, layout.cue_bounce_distance_px, 0] });
      }

      const btn = host.querySelector('button[data-testid="preview-scroll-cue"]') as HTMLButtonElement;
      expect(btn.getAttribute("aria-controls")).toBe(layout.preview_section_id);
      if (row.interaction === "click") {
        await act(async () => {
          btn.click();
        });
        if (row.target_exists === "yes") {
          expect(scrollIntoView).toHaveBeenCalledWith({
            behavior: expectReduced ? "auto" : "smooth",
            block: "start",
          });
        } else {
          expect(scrollIntoView).not.toHaveBeenCalled();
        }
      }
    },
  );
});
