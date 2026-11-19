import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Delivery is an emailed download link, sent after the webhook records the sale. It is not instant:
// the link goes out after the provider webhook, and it is not sent at all when delivery fails or the
// buyer email is missing. Buyer-facing copy must say what the code does.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const INSTANT_CLAIM = /instant(ly)?\s+download|delivered instantly|online access/i;

const BUYER_SURFACES = [
  "app/checkout/[productId]/page.tsx",
  "app/books/[handle]/[product]/page.tsx",
  "public/books/legal/terms.html",
];

describe("buyer delivery copy matches code", () => {
  it.each(BUYER_SURFACES)("%s does not promise instant download", (rel) => {
    expect(read(rel)).not.toMatch(INSTANT_CLAIM);
  });

  it("checkout page says a download link is emailed after purchase", () => {
    expect(read("app/checkout/[productId]/page.tsx")).toMatch(/download link is emailed after purchase/i);
  });

  it("terms say the download link is emailed after successful payment", () => {
    expect(read("public/books/legal/terms.html")).toMatch(/download link is emailed after successful payment/i);
  });

  it("buyer legal pages and thank-you page use curly apostrophes, never straight ASCII apostrophes in copy", () => {
    for (const rel of [
      "public/books/legal/terms.html",
      "public/books/legal/privacy.html",
      "public/books/legal/refund-policy.html",
      "public/books/legal/providers.html",
    ]) {
      const body = read(rel).replace(/<[^>]+>/g, " ");
      expect(body, rel).not.toContain("'");
    }
    const thanksSource = read("app/books/[handle]/thanks/page.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(thanksSource).toContain("\\u2019s books");
    expect(thanksSource).not.toContain("'s books");
  });
});
