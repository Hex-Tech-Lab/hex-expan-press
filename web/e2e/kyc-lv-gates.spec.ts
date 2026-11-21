import { request as apiRequest, test, expect } from "@playwright/test";
import { APP_URL, E2E, MOCK_HTTP_URL } from "./constants";

test.beforeAll(async () => {
  await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
});

for (const viewport of [
  { width: 1560, height: 960 },
  { width: 390, height: 844 },
]) {
  test.describe(`KYC live-verification gates (${viewport.width}px)`, () => {
    test.use({ viewport });

    test("LV-02: home page hides both browse-books links while storefront.browse_books_enabled is off (default), and /books still loads", async ({ page }) => {
      const res = await page.goto("/");
      expect(res?.status(), "GET / status").toBe(200);

      // Founder decision: no "browse books" link on the B2B home until several creators and house books are live.
      // The enabled-state rendering (both links, header top-right) is pinned by web/__tests__/landing-browse-books-flag.test.ts.
      await expect(page.getByTestId("header-browse-books")).toHaveCount(0);
      await expect(page.getByTestId("hero-browse-books")).toHaveCount(0);
      await expect(page.getByText("Tap to begin")).toBeVisible();

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `home horizontal overflow at ${viewport.width}px`).toBe(false);

      // Mobile header: with the browse link hidden, the wordmark must stay on the right (it is alone in its row).
      if (viewport.width < 640) {
        const wordmarkBox = await page.locator("header").first().locator('a[href="/"]').first().boundingBox();
        expect(wordmarkBox, "wordmark rendered in header").not.toBeNull();
        expect(wordmarkBox!.x + wordmarkBox!.width, `header wordmark right-aligned at ${viewport.width}px`).toBeGreaterThan(viewport.width - 48);
      }

      const booksRes = await page.goto("/books");
      expect(booksRes?.status(), "GET /books status").toBe(200);
      await expect(page.getByRole("heading", { name: "Find a book from a creator" })).toBeVisible();
    });

    test("LV-03, equal-height layout & flipbook toolbar: sample product page passes layout, scroll cue, zoom & go-to-page", async ({
      page,
    }) => {
      const res = await page.goto("/books/expanpress_house/sample_the_quiet_workshop");
      expect(res?.status(), "GET sample product page status").toBe(200);

      // Gated CTA is non-buyable, yet buyer legal links (privacy, terms, refund) still appear in footer without providers.html.
      await expect(page.locator('[data-checkout-slot="primary"][data-checkout-mode="gated"]')).toBeVisible();
      const footer = page.locator("footer");
      await expect(footer.locator('a[href="/books/legal/privacy.html"]')).toBeVisible();
      await expect(footer.locator('a[href="/books/legal/terms.html"]')).toBeVisible();
      await expect(footer.locator('a[href="/books/legal/refund-policy.html"]')).toBeVisible();
      await expect(footer.locator('a[href*="providers.html"]')).toHaveCount(0);

      // Cover & details cards: equal top and equal bottom on desktop; stacked on phone.
      const coverBox = await page.getByTestId("product-cover-col").boundingBox();
      const detailsBox = await page.getByTestId("product-details-card").boundingBox();
      expect(coverBox).not.toBeNull();
      expect(detailsBox).not.toBeNull();
      if (viewport.width >= 1024) {
        expect(Math.abs(coverBox!.y - detailsBox!.y)).toBeLessThanOrEqual(2);
        expect(Math.abs(coverBox!.y + coverBox!.height - (detailsBox!.y + detailsBox!.height))).toBeLessThanOrEqual(2);
      } else {
        expect(detailsBox!.y).toBeGreaterThanOrEqual(coverBox!.y + coverBox!.height - 2);
      }
      await expect(page.getByTestId("book-overview-scroll")).toHaveAttribute("tabindex", "0");

      // Scroll cue arrow scrolls the interactive previewer into the viewport.
      const cue = page.getByTestId("preview-scroll-cue");
      await expect(cue).toBeVisible();
      await expect(cue.getByTestId("preview-scroll-cue-arrow")).toBeVisible();
      await expect(page.getByTestId("book-preview-section")).toBeVisible();

      await cue.click();
      await expect
        .poll(
          async () =>
            page.getByTestId("book-preview-section").evaluate((el) => {
              const r = el.getBoundingClientRect();
              return r.top >= -4 && r.top < window.innerHeight;
            }),
          { timeout: 5000 },
        )
        .toBe(true);

      // Wait for StPageFlip stage + toolbar ready, then exercise zoom (2 levels), zoom out, reset, go-to-page.
      await expect(page.getByTestId("book-preview-stage")).toBeVisible({ timeout: 30000 });
      const zoomIn = page.getByTestId("book-preview-zoom-in");
      const zoomOut = page.getByTestId("book-preview-zoom-out");
      const resetZoom = page.getByTestId("book-preview-zoom-reset");
      const zoomLabel = page.getByTestId("book-preview-zoom-label");
      const previewViewport = page.getByTestId("book-preview-viewport");

      // Below sm (640px) zoom is native pinch (industry norm for phone readers); the buttons are hidden.
      if (viewport.width < 640) {
        for (const btn of [zoomIn, zoomOut, resetZoom]) await expect(btn).toBeHidden();
        await expect(zoomLabel).toHaveText("100%");
      } else {
      for (const btn of [zoomIn, zoomOut, resetZoom]) {
        const aria = await btn.getAttribute("aria-label");
        expect(aria).toBeTruthy();
        await expect(btn).toHaveAttribute("title", aria!);
      }
      await expect(zoomLabel).toHaveText("100%");
      await expect(zoomOut).toBeDisabled();
      await expect(resetZoom).toBeDisabled();

      await zoomIn.click();
      await expect(zoomLabel).toHaveText("135%");
      await expect(previewViewport).toHaveAttribute("data-zoom", "1.35");

      await zoomIn.click();
      await expect(zoomLabel).toHaveText("175%");
      await expect(previewViewport).toHaveAttribute("data-zoom", "1.75");
      await expect(zoomIn).toBeDisabled();

      // Verify no page-level horizontal overflow even when zoomed in.
      const overflowZoomed = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflowZoomed, `horizontal overflow while zoomed at ${viewport.width}px`).toBe(false);

      await zoomOut.click();
      await expect(zoomLabel).toHaveText("135%");
      await resetZoom.click();
      await expect(zoomLabel).toHaveText("100%");
      }

      // Go to page 4
      const goToInput = page.getByTestId("book-preview-goto-input");
      await goToInput.fill("4");
      await page.getByTestId("book-preview-goto-submit").click();
      await expect(page.getByTestId("book-preview-page-label")).toContainText(/Page(s)? 4/);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `sample product horizontal overflow at ${viewport.width}px`).toBe(false);
    });

    test("Legal pages: direct Back to books navigation (no loop) and providers page excluded from footers", async ({
      page,
    }) => {
      await page.goto("/books/legal/privacy.html");
      await expect(page.locator("main a[href='/books/legal/providers.html']")).toBeVisible();
      await expect(page.locator("footer a[href*='providers.html']")).toHaveCount(0);

      await page.locator("footer a[href='/books/legal/terms.html']").click();
      await expect(page).toHaveURL(/\/books\/legal\/terms\.html$/);
      await expect(page.locator("footer a[href*='providers.html']")).toHaveCount(0);

      const backLink = page.locator("a.back");
      await expect(backLink).toHaveText("← Back to books");
      await expect(backLink).toHaveAttribute("href", "/books");
      await backLink.click();
      await expect(page).toHaveURL(/\/books$/);
    });

    test(`LV-05: pay. root renders cleanly with 0 horizontal overflow at ${viewport.width}px`, async ({ page }) => {
      const pay = await apiRequest.newContext({
        baseURL: APP_URL,
        maxRedirects: 0,
        extraHTTPHeaders: { host: "pay.expanpress.com" },
      });
      try {
        const payRoot = await pay.get("/");
        expect(payRoot.status(), "pay / status").toBe(200);
        const payHtml = await payRoot.text();
        await page.route("https://pay.expanpress.com/", (route) =>
          route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: payHtml }),
        );
        await page.goto("https://pay.expanpress.com/");
        await expect(page.locator("header .name")).toHaveText("expanpress");
        await expect(page.getByRole("heading", { name: "Digital book checkout" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Browse books" })).toHaveAttribute(
          "href",
          "https://expanpress.com/books",
        );
        await expect(page.locator("footer a[href='/books/legal/privacy.html']")).toBeVisible();
        await expect(page.locator("footer a[href='/books/legal/terms.html']")).toBeVisible();
        await expect(page.locator("footer a[href='/books/legal/refund-policy.html']")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `pay. root horizontal overflow at ${viewport.width}px`).toBe(false);
      } finally {
        await pay.dispose();
      }
    });
  });
}

test("LV-05 & LV-07: pay. root uses storefront wordmark/tokens, providers headers/robots disallow, and favicon.ico returns 200 OK", async () => {
  const main = await apiRequest.newContext({ baseURL: APP_URL, maxRedirects: 0 });
  const pay = await apiRequest.newContext({
    baseURL: APP_URL,
    maxRedirects: 0,
    extraHTTPHeaders: { host: "pay.expanpress.com" },
  });
  try {
    const payRoot = await pay.get("/");
    expect(payRoot.status(), "pay / status").toBe(200);
    expect(payRoot.headers()["location"]).toBeUndefined();
    const payRootHtml = await payRoot.text();
    expect(payRootHtml).toContain('<span class="brace">{</span><span class="name">expanpress</span><span class="brace">}</span>');
    expect(payRootHtml).toContain("Digital book checkout");
    expect(payRootHtml).not.toContain("ExpanPress Checkout");
    expect(payRootHtml).toContain("https://expanpress.com/books");
    expect(payRootHtml).toContain("/books/legal/privacy.html");
    expect(payRootHtml).toContain("/books/legal/terms.html");
    expect(payRootHtml).toContain("/books/legal/refund-policy.html");
    expect(payRootHtml).not.toContain("/creator/signin");

    // Existing pay-host confinement and checkout routes remain unchanged.
    expect((await pay.get("/books")).status(), "pay /books status").toBe(404);
    expect((await pay.get("/terms.html")).status(), "pay /terms.html status").toBe(404);
    expect((await pay.get(`/checkout/${E2E.liveProductId}`)).status(), "pay /checkout/{id} status").toBe(200);

    // Service providers noindex header; robots.txt must NOT disallow them, so crawlers can read the noindex.
    const providersRes = await main.get("/books/legal/providers.html");
    expect(providersRes.status()).toBe(200);
    expect(providersRes.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    const robotsTxt = await (await main.get("/robots.txt")).text();
    expect(robotsTxt).not.toContain("/books/legal/providers.html");
    expect(robotsTxt).not.toContain("/legal/providers.html");

    // LV-07: favicon.ico returns 200 OK on both main host and pay host.
    const mainFavicon = await main.get("/favicon.ico");
    expect(mainFavicon.status(), "main /favicon.ico status").toBe(200);
    expect((await mainFavicon.body()).byteLength).toBeGreaterThan(0);

    const payFavicon = await pay.get("/favicon.ico");
    expect(payFavicon.status(), "pay /favicon.ico status").toBe(200);
    expect((await payFavicon.body()).byteLength).toBeGreaterThan(0);
  } finally {
    await main.dispose();
    await pay.dispose();
  }
});
