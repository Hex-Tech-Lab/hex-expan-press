import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { MOCK_HTTP_URL } from "./constants";

const SCREENSHOTS_DIR =
  process.env.BOOKS_SAMPLE_SHOTS_DIR ??
  path.resolve(process.cwd(), "..", "docs/handover/books_sample_listing_2026-11-20");

test.beforeAll(async () => {
  await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test("/books lists the gated sample with coming-soon pill, hides non-sample gated books, and matches /books/expanpress_house (1560 + 390)", async ({
  page,
}) => {
  // 1. Desktop 1560px on /books
  await page.setViewportSize({ width: 1560, height: 960 });
  const landingRes = await page.goto("/books");
  expect(landingRes?.status(), "GET /books status").toBe(200);

  const sampleCard = page.locator("article", { hasText: "The Quiet Workshop (Sample)" });
  await expect(sampleCard).toBeVisible();
  await expect(sampleCard.locator('[data-checkout-mode="gated"]')).toHaveText("Coming soon");
  await expect(sampleCard.getByRole("link", { name: "Preview sample" })).toHaveAttribute(
    "href",
    "/books/expanpress_house/sample_the_quiet_workshop",
  );

  // Non-sample gated book (books/duane.json has is_sample: false) must stay hidden.
  await expect(page.getByText("You Don't Need a Million Dollars to Retire")).toHaveCount(0);

  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(desktopOverflow, "desktop 1560px horizontal overflow").toBe(false);

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "01-books-1560.png"),
    fullPage: true,
  });

  // 2. Mobile 390px on /books
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sampleCard).toBeVisible();
  await expect(sampleCard.locator('[data-checkout-mode="gated"]')).toHaveText("Coming soon");
  await expect(sampleCard.getByRole("link", { name: "Preview sample" })).toBeVisible();

  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(mobileOverflow, "mobile 390px horizontal overflow").toBe(false);

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "02-books-390.png"),
    fullPage: true,
  });

  // 3. Consistency on house creator page /books/expanpress_house
  await page.setViewportSize({ width: 1560, height: 960 });
  const houseRes = await page.goto("/books/expanpress_house");
  expect(houseRes?.status(), "GET /books/expanpress_house status").toBe(200);
  const houseSampleCard = page.locator("article", { hasText: "The Quiet Workshop (Sample)" });
  await expect(houseSampleCard).toBeVisible();
  await expect(houseSampleCard.locator('[data-checkout-mode="gated"]')).toHaveText("Coming soon");
  const previewLink = houseSampleCard.getByRole("link", { name: "Preview sample" });
  await expect(previewLink).toHaveAttribute("href", "/books/expanpress_house/sample_the_quiet_workshop");

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "03-house-creator-1560.png"),
    fullPage: true,
  });

  // 4. Creator hub with no visible product (only a non-sample gated book) is 404 Not Found, not an empty shelf
  const duaneRes = await page.goto("/books/retirearly500k");
  expect(duaneRes?.status(), "GET /books/retirearly500k status").toBe(404);
  await expect(page.getByText("No books are on sale yet. Please check back soon.")).toHaveCount(0);
  await expect(page.getByText("You Don't Need a Million Dollars to Retire")).toHaveCount(0);

  // 5. Clicking Preview sample reaches the non-buyable sample product page with previewer
  await page.goto("/books");
  await page.locator("article", { hasText: "The Quiet Workshop (Sample)" }).getByRole("link", { name: "Preview sample" }).click();
  await expect(page).toHaveURL(/\/books\/expanpress_house\/sample_the_quiet_workshop$/);
  await expect(page.locator('[data-checkout-slot="primary"][data-checkout-mode="gated"]')).toBeVisible();
  await expect(page.getByTestId("book-preview-section")).toBeVisible();
});
