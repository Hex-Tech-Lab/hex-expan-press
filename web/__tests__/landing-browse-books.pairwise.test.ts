import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";
import Home from "../app/page";
import LandingPage from "../src/components/landing/landing-page";
import MaxMotionProvider from "../src/components/motion/max-motion-provider";

// Oracle for the PICT rows in docs/testing/pairwise/landing_browse_books.rows.tsv.
// Each row sets the flag and the render entry point, then asserts the header link is present exactly when enabled.
const ROWS_PATH = new URL("../../docs/testing/pairwise/landing_browse_books.rows.tsv", import.meta.url);
const HEADER_TESTID = 'data-testid="header-browse-books"';

const originalEnabled = GLOBAL.storefront.browse_books_enabled;

afterEach(() => {
  GLOBAL.storefront.browse_books_enabled = originalEnabled;
});

type Row = { browse_books_enabled: boolean; render_entry: "landing_component" | "app_page" };

function parseRows(): Row[] {
  const [header, ...lines] = readFileSync(ROWS_PATH, "utf8").trim().split("\n");
  const cols = header.split("\t");
  return lines.map((line) => {
    const cells = Object.fromEntries(line.split("\t").map((v, i) => [cols[i], v]));
    if (cells.browse_books_enabled !== "true" && cells.browse_books_enabled !== "false") {
      throw new Error(`bad browse_books_enabled cell: ${cells.browse_books_enabled}`);
    }
    if (cells.render_entry !== "landing_component" && cells.render_entry !== "app_page") {
      throw new Error(`bad render_entry cell: ${cells.render_entry}`);
    }
    return { browse_books_enabled: cells.browse_books_enabled === "true", render_entry: cells.render_entry };
  });
}

function render(row: Row): string {
  GLOBAL.storefront.browse_books_enabled = row.browse_books_enabled;
  if (row.render_entry === "app_page") return renderToStaticMarkup(createElement(Home));
  return renderToStaticMarkup(
    createElement(
      MaxMotionProvider,
      null,
      createElement(LandingPage, {
        onboarding: true,
        supportEmail: "support@example.test",
        browseBooksEnabled: row.browse_books_enabled,
        browseBooksLabel: GLOBAL.storefront.browse_books_label,
        browseBooksPath: GLOBAL.storefront.browse_books_path,
      }),
    ),
  );
}

describe("PICT rows: landing browse-books visibility", () => {
  const rows = parseRows();

  it("the committed rows file has the expected four pairs", () => {
    expect(rows).toHaveLength(4);
    const keys = new Set(rows.map((r) => `${r.browse_books_enabled}/${r.render_entry}`));
    expect(keys.size).toBe(4);
  });

  for (const row of rows) {
    it(`enabled=${row.browse_books_enabled} entry=${row.render_entry} shows header link only when enabled`, () => {
      const html = render(row);
      if (row.browse_books_enabled) expect(html).toContain(HEADER_TESTID);
      else expect(html).not.toContain(HEADER_TESTID);
    });
  }
});
