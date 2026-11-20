import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL, GLOBAL } from "../../payments/src/settings_registry";
import LandingPage from "../src/components/landing/landing-page";
import MaxMotionProvider from "../src/components/motion/max-motion-provider";

const HEADER_TESTID = 'data-testid="header-browse-books"';
const HERO_TESTID = 'data-testid="hero-browse-books"';

function renderLanding(browseBooksEnabled: boolean): string {
  return renderToStaticMarkup(
    createElement(
      MaxMotionProvider,
      null,
      createElement(LandingPage, {
        onboarding: true,
        supportEmail: "support@example.test",
        browseBooksEnabled,
        browseBooksLabel: "Browse books",
        browseBooksPath: "/books",
      }),
    ),
  );
}

describe("B2B home browse-books links (storefront.browse_books_enabled)", () => {
  it("registry default is off, so no browse-books link ships", () => {
    expect(DEFAULT_GLOBAL.storefront.browse_books_enabled).toBe(false);
    expect(GLOBAL.storefront.browse_books_enabled).toBe(false);
  });

  it("renders neither the header nor the hero browse-books link when the flag is false", () => {
    const html = renderLanding(false);
    expect(html).not.toContain(HEADER_TESTID);
    expect(html).not.toContain(HERO_TESTID);
    expect(html).not.toContain('aria-label="Storefront navigation"');
    expect(html).not.toContain('href="/books"');
    expect(html).not.toContain(">Browse books<");
  });

  it("keeps the hero pitch and the Tap to begin CTA when the flag is false", () => {
    const html = renderLanding(false);
    expect(html).toContain("Your voice deserves to be a book.");
    expect(html).toContain("Tap to begin");
  });

  it("renders both the header and the hero browse-books links when the flag is true", () => {
    const html = renderLanding(true);
    expect(html).toContain(HEADER_TESTID);
    expect(html).toContain(HERO_TESTID);
    expect(html).toContain('aria-label="Storefront navigation"');
    expect(html.match(/href="\/books"/g)?.length).toBe(2);
    expect(html).toContain("Tap to begin");
  });
});
