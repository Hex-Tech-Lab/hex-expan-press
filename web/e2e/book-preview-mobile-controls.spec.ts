import { expect, test } from "@playwright/test";

// Mobile reader controls: one row, finger-sized (>=44px) targets, no text labels below sm (640px).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const PRODUCT_URL = "/books/expanpress_house/sample_the_quiet_workshop";

function rowCount(page: import("@playwright/test").Page, testId: string): Promise<number> {
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
  // Zoom label is visually hidden below sm but must stay in the DOM as the polite live region.
  await expect(page.getByTestId("book-preview-zoom-label")).not.toHaveCSS("display", "none");
  // Visually hidden (sr-only = 1x1 clipped), not merely present.
  const zoomBox = (await page.getByTestId("book-preview-zoom-label").boundingBox())!;
  expect(zoomBox.width).toBeLessThanOrEqual(1);
  // Icon-only below sm: the Prev/Next text spans are not rendered visibly.
  await expect(bar.locator("xpath=..").getByText("Prev", { exact: true })).toBeHidden();
  await expect(bar.locator("xpath=..").getByText("Next", { exact: true })).toBeHidden();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("book-preview-goto-submit")).toBeVisible();
  // Page field is a finger-sized target too.
  const input = (await page.getByTestId("book-preview-goto-input").boundingBox())!;
  expect(input.width).toBeGreaterThanOrEqual(44);
  expect(input.height).toBeGreaterThanOrEqual(44);
  // Phones zoom by native pinch: the page-flip stage must allow pinch-zoom (page-flip's CSS default is pan-y only).
  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-stage")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("book-preview-stage")).toHaveCSS("touch-action", "pan-y pinch-zoom");
  // iOS Safari zooms the whole page on focus of any input under 16px, so the page field must be >= 16px below sm.
  const gotoFontPx = await page
    .getByTestId("book-preview-goto-input")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(gotoFontPx).toBeGreaterThanOrEqual(16);
  await parent.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/mobile-reader-controls.png" });
});

test("read-aloud controls fit one row at 390px", async ({ page }) => {
  // Headless Chromium has no speechSynthesis, so the controls never render and the row check
  // would skip. A minimal stub makes the controls render; the row geometry is what is asserted.
  await page.addInitScript(() => {
    class StubUtterance {
      text: string;
      rate = 1;
      constructor(text: string) {
        this.text = text;
      }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: StubUtterance });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        paused: false,
        pending: false,
        speak() {},
        cancel() {},
        pause() {},
        resume() {},
        getVoices: () => [],
        addEventListener() {},
        removeEventListener() {},
      },
    });
  });
  await page.goto(PRODUCT_URL);
  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", { timeout: 30_000 });
  // Read-aloud controls render for the structured page 2 (the read-aloud spec turns to it the same way).
  await page.getByRole("button", { name: "Next preview page" }).click();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Page 2 of 8");
  await expect(page.getByTestId("read-aloud-controls")).toBeVisible();
  // Start playback so the stop button renders too: that is the three-control state that used to wrap.
  await page.getByTestId("read-aloud-toggle").click();
  await expect(page.getByTestId("read-aloud-toggle")).toHaveAttribute("data-playback-state", "playing");
  await expect(page.getByTestId("read-aloud-stop")).toBeVisible();
  expect(await rowCount(page, "read-aloud-controls")).toBe(1);
  const card = (await page.getByTestId("book-preview-accessible-card").boundingBox())!;
  for (const b of await page.getByTestId("read-aloud-controls").locator("button:visible").all()) {
    const box = (await b.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  }
});

test("reset stays reachable after rotating a zoomed preview to phone width", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(PRODUCT_URL);
  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-stage")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("book-preview-zoom-in").click();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveText("135%");
  await page.setViewportSize({ width: 390, height: 844 });
  const reset = page.getByTestId("book-preview-zoom-reset");
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveText("100%");
  await expect(reset).toBeHidden();
});

test.describe("desktop keeps text labels", () => {
  test.use({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  test("Prev/Next/Go text and zoom reset visible at 1280px", async ({ page }) => {
    await page.goto(PRODUCT_URL);
    const row = page.getByTestId("book-preview-toolbar").locator("xpath=..");
    await expect(row.getByText("Prev", { exact: true })).toBeVisible();
    await expect(row.getByText("Next", { exact: true })).toBeVisible();
    await expect(page.getByTestId("book-preview-zoom-reset")).toBeVisible();
    await expect(page.getByTestId("book-preview-zoom-label")).toBeVisible();
  });
});
