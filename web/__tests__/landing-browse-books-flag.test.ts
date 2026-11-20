import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL, GLOBAL } from "../../payments/src/settings_registry";
import LandingPage from "../src/components/landing/landing-page";
import MaxMotionProvider from "../src/components/motion/max-motion-provider";

const HEADER_TESTID = 'data-testid="header-browse-books"';
const HERO_TESTID = 'data-testid="hero-browse-books"';

const originalEnabled = GLOBAL.storefront.browse_books_enabled;

afterEach(() => {
  GLOBAL.storefront.browse_books_enabled = originalEnabled;
});

// Sets the flag explicitly and feeds LandingPage the props app/page.tsx would derive from it.
function renderLanding(browseBooksEnabled: boolean): string {
  GLOBAL.storefront.browse_books_enabled = browseBooksEnabled;
  return renderToStaticMarkup(
    createElement(
      MaxMotionProvider,
      null,
      createElement(LandingPage, {
        onboarding: true,
        supportEmail: "support@example.test",
        browseBooks: browseBooksEnabled
          ? { label: GLOBAL.storefront.browse_books_label, path: GLOBAL.storefront.browse_books_path }
          : null,
      }),
    ),
  );
}

describe("B2B home browse-books links (storefront.browse_books_enabled)", () => {
  it("registry default is off, so no browse-books link ships", () => {
    expect(DEFAULT_GLOBAL.storefront.browse_books_enabled).toBe(false);
  });

  it("renders neither the header nor the hero browse-books link when the flag is false", () => {
    const html = renderLanding(false);
    expect(html).not.toContain(HEADER_TESTID);
    expect(html).not.toContain(HERO_TESTID);
    expect(html).not.toContain('aria-label="Storefront navigation"');
    expect(html).not.toContain('href="/books"');
    expect(html).not.toContain(">Browse books<");
    // Header controls row: the wordmark is alone, so it must right-align (justify-end) on every width.
    expect(html).toContain("flex items-center justify-end sm:justify-end");
    expect(html).not.toContain("flex items-center justify-between sm:justify-end");
  });

  it("keeps the hero pitch and the Tap to begin CTA when the flag is false", () => {
    const html = renderLanding(false);
    expect(html).toContain("Your voice deserves to be a book.");
    expect(html).toContain("Tap to begin");
  });

  it("renders the header browse-books link and no hero link when the flag is true", () => {
    const html = renderLanding(true);
    expect(html).toContain(HEADER_TESTID);
    expect(html).not.toContain(HERO_TESTID);
    expect(html).toContain('aria-label="Storefront navigation"');
    expect(html.match(/href="\/books"/g)?.length).toBe(1);
    expect(html).toContain("Tap to begin");
    // Header controls row: with the link shown, nav and wordmark split across the row on mobile (justify-between).
    expect(html).toContain("flex items-center justify-between sm:justify-end");
  });

  it("uses the supplied label and path for the header link (no hard-coded copy or route)", () => {
    const html = renderToStaticMarkup(
      createElement(
        MaxMotionProvider,
        null,
        createElement(LandingPage, {
          onboarding: true,
          supportEmail: "support@example.test",
          browseBooks: { label: "Explore titles", path: "/catalogue" },
        }),
      ),
    );
    expect(html.match(/href="\/catalogue"/g)?.length).toBe(1);
    expect(html.match(/>Explore titles</g)?.length).toBe(1);
    expect(html).not.toContain(HERO_TESTID);
    expect(html).not.toContain('href="/books"');
    expect(html).not.toContain(">Browse books<");
  });
});
