import { request as apiRequest, test, expect } from "@playwright/test";
import { APP_URL, E2E, MOCK_HTTP_URL } from "./constants";

test.beforeAll(async () => {
  await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
});

for (const viewport of [
  { width: 1560, height: 940 },
  { width: 390, height: 844 },
]) {
  test.describe(`Consistency HIGH fixes (${viewport.width}px)`, () => {
    test.use({ viewport });

    test("Home dock renders {ep} brand mark without truncation or overflow", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      const res = await page.goto("/");
      expect(res?.status(), "GET / status").toBe(200);

      const markTestId = viewport.width >= 1024 ? "desktop-dock-brand-mark" : "mobile-dock-brand-mark";
      const mark = page.getByTestId(markTestId);
      await expect(mark).toBeVisible();
      await expect(mark).toHaveText("{ep}");

      const box = await mark.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(36);
      expect(box!.height).toBeGreaterThanOrEqual(36);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      expect(errors).toEqual([]);
    });

    test("Creator hub omits placeholder bio and financial-security disclaimer", async ({ page }) => {
      const res = await page.goto("/books/expanpress_house");
      expect(res?.status()).toBe(200);
      await expect(page.getByText("Creator bio coming soon.")).toHaveCount(0);
      await expect(page.getByText(/buy, sell, or hold any security/i)).toHaveCount(0);
      await expect(page.getByText(/downloadable PDFs/i)).toBeVisible();

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
    });

    test("Legal pages (B2B + B2C) render unified brand tokens, {expanpress} wordmark, and accurate B2B footers", async ({ page }) => {
      for (const path of ["/terms.html", "/privacy.html", "/refund-policy.html", "/legal/providers.html"]) {
        const res = await page.goto(path);
        expect(res?.status(), `${path} status`).toBe(200);
        await expect(page.locator("header .wordmark")).toHaveText("{expanpress}");
        await expect(page.locator("footer")).toContainText("© 2026 ExpanPress");
        await expect(page.locator('footer a[href="/"]:has-text("Product page")')).toHaveCount(0);
        await expect(page.locator('footer a[href="/"]:has-text("Books")')).toHaveCount(0);

        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(bg).toBe("rgb(249, 246, 240)");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `${path} overflow`).toBe(false);
      }

      const b2cRes = await page.goto("/books/legal/terms.html");
      expect(b2cRes?.status()).toBe(200);
      await expect(page.locator("header .wordmark")).toHaveText("{expanpress}");
      await expect(page.locator("footer")).toContainText("© 2026 ExpanPress");
      // Founder-review draft highlights stay intact until founder sign-off.
      expect(await page.locator("mark.review").count()).toBeGreaterThan(0);
    });

    test("Creator portal pages have non-zero card padding, unified chrome, and review back-to-dashboard link", async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("pageerror", (err) => consoleErrors.push(err.message));

      // Sign-in
      const signRes = await page.goto("/creator/signin");
      expect(signRes?.status()).toBe(200);
      await expect(page.getByRole("link", { name: "ExpanPress home" })).toBeVisible();
      await expect(page.getByText("Access your books and account details.")).toBeVisible();
      await expect(page.getByRole("button", { name: /Continue with Apple/i })).toBeDisabled();

      // Authenticate via mock callback
      await page.goto(`/auth/callback?token_hash=${E2E.magicLinkTokenHash}&type=magiclink`);
      await expect(page).toHaveURL(/\/creator\/dashboard/);

      for (const route of ["/creator/dashboard", "/creator/consents", "/creator/consents/esign_done", "/creator/review"]) {
        const res = await page.goto(route);
        expect(res?.status(), `${route} status`).toBe(200);
        await expect(page.getByRole("link", { name: /ExpanPress home|Creator dashboard/ })).toBeVisible();
        await expect(page.locator("footer")).toContainText("© 2026 ExpanPress");

        const padTop = await page.locator(".neu-card").first().evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
        expect(padTop, `${route} card paddingTop`).toBeGreaterThanOrEqual(20);

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow, `${route} overflow`).toBe(false);
      }

      await page.goto("/creator/consents");
      await expect(page.locator("#typedName-C1_data_accuracy")).toHaveAttribute("placeholder", "Full legal name");

      await page.goto("/creator/review");
      await expect(page.getByTestId("review-back-to-dashboard")).toBeVisible();
      await expect(page.getByTestId("review-back-to-dashboard")).toHaveAttribute("href", "/creator/dashboard");

      expect(consoleErrors).toEqual([]);
    });

    test("Checkout 403 Forbidden (non-US) and Download 404 Not Found render branded HTML pages", async ({ page }) => {
      // Download 404 Not Found in browser (Accept: text/html)
      const dlRes = await page.goto("/books/d/00000000000000000000000000000000");
      expect(dlRes?.status()).toBe(404);
      await expect(page.locator("header .wordmark")).toHaveText("{expanpress}");
      await expect(page.getByText("404 Not Found")).toBeVisible();
      await expect(page.locator(`a[href="https://expanpress.com/books"]`).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

      // Checkout 403 Forbidden (non-US geo-gate) via browser navigation with x-vercel-ip-country: DE
      await page.setExtraHTTPHeaders({ "x-vercel-ip-country": "DE" });
      const coRes = await page.goto(`/checkout/${E2E.liveProductId}`);
      expect(coRes?.status()).toBe(403);
      await expect(page.locator("header .wordmark")).toHaveText("{expanpress}");
      await expect(page.getByText(/403 Forbidden/i)).toBeVisible();
      await expect(page.locator(`a[href="https://expanpress.com/books"]`).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    });
  });
}

test("Checkout API 403 Forbidden still returns JSON while HTML GET returns branded 403 Forbidden", async () => {
  const pay = await apiRequest.newContext({
    baseURL: APP_URL,
    maxRedirects: 0,
    extraHTTPHeaders: { host: "pay.expanpress.com", "x-vercel-ip-country": "DE" },
  });
  try {
    const apiRes = await pay.post("/api/billing/checkout", { data: { product: E2E.liveProductId } });
    expect(apiRes.status()).toBe(403);
    expect(await apiRes.json()).toMatchObject({ ok: false, code: "country_not_supported" });

    const htmlRes = await pay.get(`/checkout/${E2E.liveProductId}`, { headers: { accept: "text/html" } });
    expect(htmlRes.status()).toBe(403);
    expect(htmlRes.headers()["content-type"]).toContain("text/html");
    const html = await htmlRes.text();
    expect(html).toContain("403 Forbidden");
    expect(html).toContain("{</span><span class=\"name\">expanpress</span>");
  } finally {
    await pay.dispose();
  }
});
