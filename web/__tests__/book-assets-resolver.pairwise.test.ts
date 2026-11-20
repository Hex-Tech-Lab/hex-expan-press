import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";
import { isSafeCoverPath, isSafePreviewPdfPath, resolveProductBookAssets } from "../src/lib/book-assets";

// Oracle for docs/testing/pairwise/book_assets_resolver.rows.tsv (model: book_assets_resolver.model.txt).
// The committed rows must equal PICT's output for the model, and each row must resolve as the oracle says.
const MODEL = new URL("../../docs/testing/pairwise/book_assets_resolver.model.txt", import.meta.url).pathname;
const ROWS = new URL("../../docs/testing/pairwise/book_assets_resolver.rows.tsv", import.meta.url).pathname;
const PICT = "/usr/local/bin/pict";
const SMOKE = JSON.parse(readFileSync(new URL("../../books/smoke.json", import.meta.url), "utf8")) as {
  cover_image?: unknown;
  preview_pdf?: unknown;
  overview?: unknown;
};

type Row = { house: "yes" | "no"; override: "slug" | "none"; book_registry: "present" | "absent"; is_sample: "true" | "false" | "absent" };

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

function oracle(row: Row) {
  const none = { book_registry: null, cover_image: null, preview_pdf: null, is_sample: false, overview: null };
  if (row.house === "no") return none;
  const registryPresent = row.book_registry === "present";
  const hasOverride = row.override === "slug";
  if (!registryPresent && !hasOverride) return none;
  const cover = isSafeCoverPath(SMOKE.cover_image) ? (SMOKE.cover_image as string).trim() : null;
  const preview = isSafePreviewPdfPath(SMOKE.preview_pdf) ? (SMOKE.preview_pdf as string).trim() : null;
  const overview = typeof SMOKE.overview === "string" && SMOKE.overview.trim() !== "" ? SMOKE.overview.trim() : null;
  return {
    book_registry: "books/smoke.json",
    cover_image: cover,
    preview_pdf: preview,
    is_sample: row.is_sample === "true",
    overview,
  };
}

describe("book-assets resolver pairwise rows", () => {
  const committed = readFileSync(ROWS, "utf8");
  const rows = parseRows(committed);

  it("the committed rows equal PICT's output for the model", () => {
    const generated = execFileSync(PICT, [MODEL], { encoding: "utf8" });
    expect(committed.trim()).toBe(generated.trim());
  });

  it("covers all 4 factors in pairs (every pair of values appears in some row)", () => {
    const factors = ["house", "override", "book_registry", "is_sample"] as const;
    const values: Record<(typeof factors)[number], string[]> = {
      house: ["yes", "no"],
      override: ["slug", "none"],
      book_registry: ["present", "absent"],
      is_sample: ["true", "false", "absent"],
    };
    for (let i = 0; i < factors.length; i++) {
      for (let j = i + 1; j < factors.length; j++) {
        for (const a of values[factors[i]]) {
          for (const b of values[factors[j]]) {
            const covered = rows.some((r) => String(r[factors[i]]) === a && String(r[factors[j]]) === b);
            // is_sample=absent with override=none is excluded by the model constraint, so that pair is not required.
            const excluded = (factors[i] === "override" && a === "none" && factors[j] === "is_sample" && b !== "absent") || (factors[j] === "override" && b === "none" && factors[i] === "is_sample" && a !== "absent");
            if (excluded) continue;
            expect(covered, `${factors[i]}=${a} & ${factors[j]}=${b}`).toBe(true);
          }
        }
      }
    }
  });

  rows.forEach((row, index) => {
    it(`row ${index + 1}: house=${row.house} override=${row.override} book_registry=${row.book_registry} is_sample=${row.is_sample}`, () => {
      const slug = `pw_probe_${index + 1}`;
      if (row.override === "slug") {
        const entry: { book_registry: string; is_sample?: boolean } = { book_registry: "books/smoke.json" };
        if (row.is_sample !== "absent") entry.is_sample = row.is_sample === "true";
        (GLOBAL.storefront.book_assets as Record<string, unknown>)[slug] = entry;
      }
      const resolved = resolveProductBookAssets({
        id: `ffffffff-0000-4000-8000-00000000000${index + 1}`,
        slug,
        book_registry: row.book_registry === "present" ? "books/smoke.json" : null,
        creator_is_house: row.house === "yes",
      });
      expect(resolved).toEqual(oracle(row));
    });
  });
});
