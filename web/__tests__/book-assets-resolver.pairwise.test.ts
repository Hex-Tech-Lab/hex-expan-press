import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";
import { isSafeCoverPath, isSafePreviewPdfPath, resolveProductBookAssets } from "../src/lib/book-assets";

// Oracle for docs/testing/pairwise/book_assets_resolver.rows.tsv (model: book_assets_resolver.model.txt).
// The committed rows must equal PICT's output for the model, and each row must resolve as the oracle says.
const MODEL = new URL("../../docs/testing/pairwise/book_assets_resolver.model.txt", import.meta.url).pathname;
const ROWS = new URL("../../docs/testing/pairwise/book_assets_resolver.rows.tsv", import.meta.url).pathname;
const PICT = "/usr/local/bin/pict";

// Registry files the model draws from. Their product_id and is_sample are read from the real books/*.json.
const FILES = {
  sample_book: { path: "books/sample_the_quiet_workshop.json", url: "../../books/sample_the_quiet_workshop.json" },
  duane_book: { path: "books/duane.json", url: "../../books/duane.json" },
} as const;
type BookJson = { product_id?: unknown; is_sample?: unknown; cover_image?: unknown; preview_pdf?: unknown; overview?: unknown };
const readBook = (url: string): BookJson => JSON.parse(readFileSync(new URL(url, import.meta.url), "utf8")) as BookJson;
const BOOKS = { sample_book: readBook(FILES.sample_book.url), duane_book: readBook(FILES.duane_book.url) };
const OTHER_ID = "ffffffff-0000-4000-8000-000000000001";

type Row = {
  house: "yes" | "no";
  override: "slug" | "none";
  book_file: "sample_book" | "duane_book" | "none";
  identity: "match" | "mismatch" | "missing";
  sample_source: "true" | "false" | "absent";
};

afterEach(() => {
  for (const key of Object.keys(GLOBAL.storefront.book_assets)) {
    if (key.startsWith("pw_probe_")) delete (GLOBAL.storefront.book_assets as Record<string, unknown>)[key];
  }
});

function parseRows(text: string): Row[] {
  const [header, ...lines] = text.trim().split("\n");
  const cols = header.split("\t");
  return lines.map((line) => {
    const cells = Object.fromEntries(line.split("\t").map((v, i) => [cols[i], v]));
    return cells as unknown as Row;
  });
}

// The file the resolver reads: the product row's book_file, else (house + slug override) the override's file.
function fileOf(row: Row): keyof typeof BOOKS | null {
  if (row.book_file !== "none") return row.book_file;
  return row.house === "yes" && row.override === "slug" ? "duane_book" : null;
}

function oracle(row: Row) {
  const none = { book_registry: null, cover_image: null, preview_pdf: null, is_sample: false, overview: null };
  const file = fileOf(row);
  if (file === null) return none;
  // Only a house creator uses the slug override. A non-house product takes the file only on exact product_id identity.
  if (row.house === "no" && row.identity !== "match") return none;
  const book = BOOKS[file];
  const overrideApplies = row.house === "yes" && row.override === "slug";
  const cover = isSafeCoverPath(book.cover_image) ? (book.cover_image as string).trim() : null;
  const preview = isSafePreviewPdfPath(book.preview_pdf) ? (book.preview_pdf as string).trim() : null;
  const overview = typeof book.overview === "string" && book.overview.trim() !== "" ? book.overview.trim() : null;
  // The override flag applies only to a house product with a slug override. The registry file's own flag always applies.
  const overrideSample = overrideApplies && row.sample_source === "true";
  return {
    book_registry: FILES[file].path,
    cover_image: cover,
    preview_pdf: preview,
    is_sample: overrideSample || book.is_sample === true,
    overview,
  };
}

// Pairs the model forbids (constraints) are not required by the coverage check.
function excludedPair(a: [string, string], b: [string, string]): boolean {
  const [fa, va] = a;
  const [fb, vb] = b;
  const pair = (x: string, y: string, vx: string, vy: string) => fa === x && fb === y && va === vx && vb === vy;
  const mirror = (x: string, y: string, vx: string, vy: string) => pair(y, x, vy, vx);
  const forbidden: Array<[string, string, string, string]> = [
    ["book_file", "identity", "none", "match"],
    ["book_file", "identity", "none", "mismatch"],
    ["sample_source", "override", "true", "none"],
    ["sample_source", "override", "false", "none"],
  ];
  return forbidden.some(([x, y, vx, vy]) => pair(x, y, vx, vy) || mirror(x, y, vx, vy));
}

describe("book-assets resolver pairwise rows", () => {
  const committed = readFileSync(ROWS, "utf8");
  const rows = parseRows(committed);

  it("the committed rows equal PICT's output for the model", () => {
    if (!existsSync(PICT)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT}`);
      return;
    }
    const generated = execFileSync(PICT, [MODEL], { encoding: "utf8" });
    expect(committed.trim()).toBe(generated.trim());
    expect(rows).toHaveLength(13);
  });

  it("covers every allowed value pair in some row", () => {
    const values: Record<string, string[]> = {
      house: ["yes", "no"],
      override: ["slug", "none"],
      book_file: ["sample_book", "duane_book", "none"],
      identity: ["match", "mismatch", "missing"],
      sample_source: ["true", "false", "absent"],
    };
    const factors = Object.keys(values);
    for (let i = 0; i < factors.length; i++) {
      for (let j = i + 1; j < factors.length; j++) {
        for (const a of values[factors[i]]) {
          for (const b of values[factors[j]]) {
            if (excludedPair([factors[i], a], [factors[j], b])) continue;
            const covered = rows.some((r) => String(r[factors[i] as keyof Row]) === a && String(r[factors[j] as keyof Row]) === b);
            expect(covered, `${factors[i]}=${a} & ${factors[j]}=${b}`).toBe(true);
          }
        }
      }
    }
  });

  rows.forEach((row, index) => {
    it(`row ${index + 1}: house=${row.house} override=${row.override} book_file=${row.book_file} identity=${row.identity} sample_source=${row.sample_source}`, () => {
      const slug = `pw_probe_${index + 1}`;
      const file = fileOf(row);
      if (row.override === "slug") {
        const entry: { book_registry: string; is_sample?: boolean } = { book_registry: FILES.duane_book.path };
        if (row.sample_source === "true" || row.sample_source === "false") {
          entry.is_sample = row.sample_source === "true";
        }
        (GLOBAL.storefront.book_assets as Record<string, unknown>)[slug] = entry;
      }
      // identity: the product id equals, differs from, or is absent relative to the resolved file's product_id.
      const fileId = file ? BOOKS[file].product_id : undefined;
      const id = row.identity === "missing" ? null : row.identity === "match" && typeof fileId === "string" ? fileId : OTHER_ID;
      const resolved = resolveProductBookAssets({
        id,
        slug,
        book_registry: row.book_file === "none" ? null : FILES[row.book_file].path,
        creator_is_house: row.house === "yes",
      });
      expect(resolved).toEqual(oracle(row));
    });
  });
});
