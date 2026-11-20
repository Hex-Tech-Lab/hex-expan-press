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

    test("LV-02: home page links to /books from header nav and hero and navigates cleanly", async ({ page }) => {
      const res = await page.goto("/");
      expect(res?.status(), "GET / status").toBe(200);

      const headerLink = page.getByTestId("header-browse-books");
      await expect(headerLink).toBeVisible();
      await expect(headerLink).toHaveText("Browse books");
      await expect(headerLink).toHaveAttribute("href", "/books");

      const heroLink = page.getByTestId("hero-browse-books");
      await expect(heroLink).toBeVisible();
      await expect(heroLink).toHaveText("Browse books");
      await expect(heroLink).toHaveAttribute("href", "/books");

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `home horizontal overflow at ${viewport.width}px`).toBe(false);

      await heroLink.click();
      await expect(page).toHaveURL(/\/books$/);
      await expect(page.getByRole("heading", { name: "Find a book from a creator" })).toBeVisible();
    });

    test("LV-03 & scroll cue: gated sample product page shows buyer legal links and arrow scrolls to previewer", async ({
      page,
    }) => {
      const res = await page.goto("/books/expanpress_house/sample_the_quiet_workshop");
      expect(res?.status(), "GET sample product page status").toBe(200);

      // Gated CTA is non-buyable, yet buyer legal links (privacy, terms, refund) still appear in footer.
      await expect(page.locator('[data-checkout-slot="primary"][data-checkout-mode="gated"]')).toBeVisible();
      const footer = page.locator("footer");
      await expect(footer.locator('a[href="/books/legal/privacy.html"]')).toBeVisible();
      await expect(footer.locator('a[href="/books/legal/terms.html"]')).toBeVisible();
      await expect(footer.locator('a[href="/books/legal/refund-policy.html"]')).toBeVisible();

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

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, `sample product horizontal overflow at ${viewport.width}px`).toBe(false);
    });
  });
}

test("LV-05 & LV-07: pay. root returns 200 OK pay page, checkout stays intact, and favicon.ico returns 200 OK on both hosts", async () => {
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
    expect(payRootHtml).toContain("ExpanPress Checkout");
    expect(payRootHtml).toContain("https://expanpress.com/books");
    expect(payRootHtml).toContain("/books/legal/privacy.html");
    expect(payRootHtml).toContain("/books/legal/terms.html");
    expect(payRootHtml).toContain("/books/legal/refund-policy.html");
    expect(payRootHtml).not.toContain("/creator/signin");

    // Existing pay-host confinement and checkout routes remain unchanged.
    expect((await pay.get("/books")).status(), "pay /books status").toBe(404);
    expect((await pay.get("/terms.html")).status(), "pay /terms.html status").toBe(404);
    expect((await pay.get(`/checkout/${E2E.liveProductId}`)).status(), "pay /checkout/{id} status").toBe(200);

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
