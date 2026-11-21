import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL, GLOBAL } from "../../payments/src/settings_registry";
import Home from "../app/page";

const HEADER_TESTID = 'data-testid="header-browse-books"';
const HERO_TESTID = 'data-testid="hero-browse-books"';

const originalEnabled = GLOBAL.storefront.browse_books_enabled;

afterEach(() => {
  GLOBAL.storefront.browse_books_enabled = originalEnabled;
});

// Home is a plain server component: rendering it wires GLOBAL.storefront.* into LandingPage.
function renderHome(enabled: boolean): string {
  GLOBAL.storefront.browse_books_enabled = enabled;
  return renderToStaticMarkup(createElement(Home));
}

describe("app/page.tsx wires storefront.browse_books_enabled into the B2B home", () => {
  it("hides both browse-books links with the shipped default", () => {
    expect(DEFAULT_GLOBAL.storefront.browse_books_enabled).toBe(false);
    const html = renderHome(DEFAULT_GLOBAL.storefront.browse_books_enabled);
    expect(html).not.toContain(HEADER_TESTID);
    expect(html).not.toContain(HERO_TESTID);
    expect(html).toContain("Tap to begin");
  });

  it("renders the header browse-books link only, never the hero link, when the flag is true", () => {
    const html = renderHome(true);
    expect(html).toContain(HEADER_TESTID);
    expect(html).not.toContain(HERO_TESTID);
    expect(html.match(/href="\/books"/g)?.length).toBe(1);
  });
});
