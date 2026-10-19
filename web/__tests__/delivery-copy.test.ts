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
  "public/terms.html",
];

describe("buyer delivery copy matches code", () => {
  it.each(BUYER_SURFACES)("%s does not promise instant download", (rel) => {
    expect(read(rel)).not.toMatch(INSTANT_CLAIM);
  });

  it("checkout page says a download link is emailed after purchase", () => {
    expect(read("app/checkout/[productId]/page.tsx")).toMatch(/download link is emailed after purchase/i);
  });

  it("terms say the download link is emailed after successful payment", () => {
    expect(read("public/terms.html")).toMatch(/download link is emailed after successful payment/i);
  });
});
