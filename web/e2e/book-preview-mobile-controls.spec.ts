import { expect, test } from "@playwright/test";

// Mobile reader controls: one row, finger-sized (>=44px) targets, no text labels below sm (640px).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const PRODUCT_URL = "/books/expanpress_house/sample_the_quiet_workshop";

async function rowCount(page: import("@playwright/test").Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => {
    const tops = new Set<number>();
    for (const c of Array.from(el.querySelectorAll("button, input"))) {
      const r = (c as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top + r.height / 2));
    }
    return tops.size;
  });
}

test("flipbook toolbar fits one row with >=44px targets at 390px", async ({ page }) => {
  await page.goto(PRODUCT_URL);
  const bar = page.getByTestId("book-preview-toolbar");
  await expect(bar).toBeVisible();
  const parent = bar.locator("xpath=..");
  const testId = "book-preview-toolbar-row";
  await parent.evaluate((el, id) => el.setAttribute("data-testid", id), testId);
  expect(await rowCount(page, testId)).toBe(1);
  for (const b of await parent.locator("button:visible").all()) {
    const box = await b.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const rowBox = (await bar.locator("xpath=../..").boundingBox())!;
  for (const c of await parent.locator("button:visible, input:visible").all()) {
    const box = (await c.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
  }
  await expect(page.getByTestId("book-preview-zoom-reset")).toBeHidden();
  await expect(page.getByTestId("book-preview-goto-submit")).toBeVisible();
  await parent.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/mobile-reader-controls.png" });
});

test("read-aloud controls fit one row at 390px", async ({ page }) => {
  await page.goto(PRODUCT_URL);
  const ra = page.getByTestId("read-aloud-controls");
  if (!(await ra.isVisible())) test.skip(true, "read-aloud not offered in this browser");
  expect(await rowCount(page, "read-aloud-controls")).toBe(1);
});
