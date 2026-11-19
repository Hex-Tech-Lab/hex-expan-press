import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { MOCK_HTTP_URL } from "./constants";

const SCREENSHOTS_DIR =
  process.env.BOOK_PREVIEW_SHOTS_DIR ??
  "/home/kellyb_dev/projects/hex-expan/docs/handover/book-card-preview-2026-11-19";

test.beforeAll(async () => {
  await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test("book cards on /books show DIGITAL PDF header, aspect-preserving cover, and (Sample) footer (desktop + mobile)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto("/books");
  expect(res?.status()).toBe(200);

  await expect(page.getByText("DIGITAL PDF").first()).toBeVisible();
  const sampleImg = page.locator('img[src="/books/covers/sample_the_quiet_workshop.png"]');
  await expect(sampleImg).toBeVisible();

  const metrics = await sampleImg.evaluate((el) => {
    const img = el as HTMLImageElement;
    const rect = img.getBoundingClientRect();
    const naturalRatio = img.naturalWidth / Math.max(img.naturalHeight, 1);
    const renderedRatio = rect.width / Math.max(rect.height, 1);
    return {
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      ratioDiff: Math.abs(naturalRatio - renderedRatio),
    };
  });
  expect(metrics.complete).toBe(true);
  expect(metrics.naturalWidth).toBeGreaterThan(0);
  expect(metrics.ratioDiff).toBeLessThan(0.03);

  await expect(page.locator("article", { hasText: "The Quiet Workshop" })).toContainText("(Sample)");
  await expect(page.locator("article", { hasText: "The Quiet Workshop" })).toContainText("ExpanPress");

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "01-books-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(mobileOverflow).toBe(false);

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "02-books-mobile.png"),
    fullPage: true,
  });
});

test("product page previewer turns to two-page spread on desktop and fits portrait on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto("/books/retirearly500k/500k_playbook");
  expect(res?.status()).toBe(200);

  const coverImg = page.locator('img[src="/books/covers/duane.jpg"]');
  await expect(coverImg).toBeVisible();

  const previewSection = page.getByTestId("book-preview-section");
  await expect(previewSection).toBeVisible();

  const pageLabel = page.getByTestId("book-preview-page-label");
  await expect(pageLabel).toHaveText("Front cover · Page 1 of 12", { timeout: 30_000 });

  const nextBtn = page.getByRole("button", { name: "Next preview page" });
  await expect(nextBtn).toBeEnabled();
  await nextBtn.click();

  await expect(pageLabel).toHaveText("Pages 2–3 of 12");
  await expect(page.locator('[data-testid="book-preview-stage"] canvas')).toBeVisible();

  // Wait briefly for flip animation to settle before screenshot
  await page.waitForTimeout(800);
  await previewSection.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "03-product-preview-two-pages-desktop.png"),
    fullPage: true,
  });

  // Also verify turning forward to Chapter 1 and back
  await nextBtn.click();
  await expect(pageLabel).toHaveText("Pages 4–5 of 12");
  await page.getByRole("button", { name: "Previous preview page" }).click();
  await expect(pageLabel).toHaveText("Pages 2–3 of 12");

  // Mobile portrait verification (reload at mobile viewport so StPageFlip initializes in portrait)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(pageLabel).toHaveText("Front cover · Page 1 of 12", { timeout: 30_000 });
  await page.getByRole("button", { name: "Next preview page" }).click();
  await expect(pageLabel).toHaveText("Page 2 of 12");
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(mobileOverflow).toBe(false);

  await page.waitForTimeout(800);
  await previewSection.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "04-product-preview-mobile.png"),
    fullPage: true,
  });
});

test("sample product page loads its own sample preview PDF", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto("/books/expanpress_house/sample_the_quiet_workshop");
  expect(res?.status()).toBe(200);
  await expect(page.locator('img[src="/books/covers/sample_the_quiet_workshop.png"]')).toBeVisible();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", { timeout: 30_000 });
});
