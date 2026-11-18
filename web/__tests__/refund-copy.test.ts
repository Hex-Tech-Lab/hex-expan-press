import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The code does not revoke download access on refund or chargeback (backlog: refund revocation). Refund copy
// must therefore not promise that access ends. Refund copy must say that the Merchant of Record decides refunds,
// without naming a specific provider.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const REVOCATION_CLAIM = /revok|access (ends|will end|is removed|is terminated|stops)|lose (your )?access|no longer (have|hold) access|terminat\w* (your )?access/i;

// Payment and infrastructure provider names. Buyer pages must not name any of them: provider names live only in
// the buyer providers page (web/public/books/legal/providers.html), which the buyer pages link to.
const PROVIDER_NAME = /\b(paddle|polar|creem|stripe|lemon ?squeezy|payhip|supabase|resend|vercel|cloudflare|sentry|upstash|google|firma|openrouter|exa|brave|hikerapi|decodo|youtube)\b/i;
const BUYER_PAGES = ["public/books/legal/terms.html", "public/books/legal/privacy.html", "public/books/legal/refund-policy.html"];

describe("refund copy matches code", () => {
  it("does not promise that download access is revoked on refund", () => {
    expect(read("public/refund-policy.html")).not.toMatch(REVOCATION_CLAIM);
    expect(read("public/terms.html")).not.toMatch(REVOCATION_CLAIM);
  });

  it("names the Merchant of Record generically as the party that decides refunds", () => {
    expect(read("public/refund-policy.html")).toMatch(/Merchant of Record/i);
  });
});

describe("buyer refund copy (B2C set)", () => {
  it("does not promise that download access is revoked on refund", () => {
    expect(read("public/books/legal/refund-policy.html")).not.toMatch(REVOCATION_CLAIM);
    expect(read("public/books/legal/terms.html")).not.toMatch(REVOCATION_CLAIM);
  });

  it("names the Merchant of Record on the receipt as the party that decides refunds", () => {
    expect(read("public/books/legal/refund-policy.html")).toMatch(/Merchant of Record named on your receipt/i);
  });

  it("names no payment or infrastructure provider on the buyer pages", () => {
    for (const page of BUYER_PAGES) {
      expect(read(page), page).not.toMatch(PROVIDER_NAME);
    }
  });

  it("links the buyer pages to the single providers page", () => {
    expect(read("public/books/legal/privacy.html")).toMatch(/href="\/books\/legal\/providers\.html"/);
  });
});
