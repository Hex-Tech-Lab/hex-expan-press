import { readFileSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandCompactMark } from "../src/components/brand/brand";
import { GLOBAL } from "../../payments/src/settings_registry";

const WEB = path.resolve(import.meta.dirname, "..");
const readWeb = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");

describe("brand compact mark & registry consistency", () => {
  it("BrandCompactMark renders {ep}", () => {
    const html = renderToStaticMarkup(React.createElement(BrandCompactMark));
    expect(html).toContain("{");
    expect(html).toContain("ep");
    expect(html).toContain("}");
    expect(html).toContain('aria-hidden="true"');
  });

  it("landing page uses BrandCompactMark in both desktop and mobile docks", () => {
    const src = readWeb("src/components/landing/landing-page.tsx");
    expect(src).toContain('data-testid="desktop-dock-brand-mark"');
    expect(src).toContain('data-testid="mobile-dock-brand-mark"');
    expect(src.match(/<BrandCompactMark\b/g)?.length).toBe(2);
  });

  it("settings_registry defines house_creator_bio and non-financial general disclaimers", () => {
    expect(GLOBAL.storefront.house_creator_bio).toContain(GLOBAL.storefront.brand_name);
    expect(GLOBAL.landing.disclaimers.length).toBeGreaterThanOrEqual(2);
    expect(GLOBAL.landing.disclaimers.join(" ")).not.toMatch(/buy, sell, or hold any security/i);
  });
});

describe("legal pages brand chrome and B2B footer accuracy", () => {
  const ALL_LEGAL = [
    "public/terms.html",
    "public/privacy.html",
    "public/refund-policy.html",
    "public/legal/providers.html",
    "public/books/legal/terms.html",
    "public/books/legal/privacy.html",
    "public/books/legal/refund-policy.html",
    "public/books/legal/providers.html",
  ];

  it.each(ALL_LEGAL)("%s uses legal-brand.css, {expanpress} wordmark, and copyright footer", (rel) => {
    const doc = readWeb(rel);
    expect(doc).toContain('href="/assets/legal-brand.css"');
    expect(doc).toContain('<span class="brace">{</span><span class="name">expanpress</span><span class="brace">}</span>');
    expect(doc).toContain("&copy; 2026 ExpanPress");
    expect(doc).not.toContain("#FAF5EE");
  });

  it("B2B legal pages fix footer labels/destinations and do not label / as Product page or Books", () => {
    for (const rel of ["public/terms.html", "public/privacy.html", "public/refund-policy.html", "public/legal/providers.html"]) {
      const footer = readWeb(rel).match(/<footer>([\s\S]*?)<\/footer>/)?.[1] ?? "";
      expect(footer, rel).not.toMatch(/<a href="\/">(?:Product page|Books)<\/a>/);
      expect(footer, rel).not.toMatch(/href="\/terms\.html">Terms of Sale<\/a>/);
    }
  });

  it("B2C legal pages have zero unresolved <mark class=\"review\"> draft highlights", () => {
    let totalMarks = 0;
    for (const rel of [
      "public/books/legal/terms.html",
      "public/books/legal/privacy.html",
      "public/books/legal/refund-policy.html",
      "public/books/legal/providers.html",
    ]) {
      totalMarks += readWeb(rel).match(/<mark class="review">/g)?.length ?? 0;
    }
    expect(totalMarks).toBe(0);
  });
});

describe("creator portal tokens & shared chrome", () => {
  it("astryx-tokens.css defines --space-4, --space-5, --space-6 and portal components do not reference undefined --space-* vars", () => {
    const css = readWeb("app/creator/astryx-tokens.css");
    expect(css).toContain("--space-4:");
    expect(css).toContain("--space-5:");
    expect(css).toContain("--space-6:");
    for (const rel of [
      "app/creator/dashboard/page.tsx",
      "app/creator/dashboard/dashboard-client.tsx",
      "app/creator/consents/consent-cards.tsx",
      "app/creator/consents/esign_done/page.tsx",
      "app/creator/review/review-client.tsx",
    ]) {
      expect(readWeb(rel), rel).not.toContain("--space-");
    }
  });

  it("all portal surfaces use BrandFrame, BrandWordmark, BrandFooter and close HIGH defects", () => {
    const signin = readWeb("app/creator/signin/signin-client.tsx");
    expect(signin).toContain("BrandFrame");
    expect(signin).toContain("BrandWordmark");
    expect(signin).toContain("BrandFooter");
    expect(signin).toContain("Access your books and account details.");
    expect(signin).not.toContain("Access your guides");
    expect(signin).toContain('aria-disabled="true"');

    const consents = readWeb("app/creator/consents/consent-cards.tsx");
    expect(consents).toContain("BrandFrame");
    expect(consents).toContain('placeholder="Full legal name"');
    expect(consents).not.toContain("First Last");

    const review = readWeb("app/creator/review/review-client.tsx");
    expect(review).toContain("BrandFrame");
    expect(review).toContain('data-testid="review-back-to-dashboard"');
    expect(review).toContain("← Back to dashboard");

    const esignDone = readWeb("app/creator/consents/esign_done/page.tsx");
    expect(esignDone).toContain("BrandFrame");
    expect(esignDone).toContain("BrandWordmark");
    expect(esignDone).toContain("BrandFooter");
  });
});
