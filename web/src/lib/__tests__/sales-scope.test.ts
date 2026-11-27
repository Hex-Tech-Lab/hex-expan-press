import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COUNTRY_RESTRICTION_MESSAGE } from "../sales-scope";

const TERMS_HTML_PATH = fileURLToPath(new URL("../../../public/books/legal/terms.html", import.meta.url));

describe("COUNTRY_RESTRICTION_MESSAGE and Terms of Sale parity", () => {
  it("matches the exact US-only sales restriction sentence", () => {
    expect(COUNTRY_RESTRICTION_MESSAGE).toBe(
      "We currently sell only to buyers in the United States, its territories, and the District of Columbia.",
    );

    // Negative control: the restriction copy must not claim worldwide or global sales.
    expect(COUNTRY_RESTRICTION_MESSAGE).not.toMatch(/\b(worldwide|globally)\b/i);
  });

  it("matches the exact sentence in web/public/books/legal/terms.html", () => {
    const termsHtml = readFileSync(TERMS_HTML_PATH, "utf8");
    expect(termsHtml).toContain(
      "We currently sell only to buyers in the United States, its territories, and the District of Columbia.",
    );

    // Negative control: terms.html must not claim worldwide or global sales.
    expect(termsHtml).not.toMatch(/\b(worldwide|globally)\b/i);
  });
});
