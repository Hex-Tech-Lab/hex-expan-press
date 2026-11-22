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

test("flipbook toolbar fits one row with 44x44px targets and working zoom at 390px", async ({ page }) => {
  await page.goto(PRODUCT_URL);
  const bar = page.getByTestId("book-preview-toolbar");
  await expect(bar).toBeVisible();
  const parent = bar.locator("xpath=..");
  const testId = "book-preview-toolbar-row";
  await parent.evaluate((el, id) => el.setAttribute("data-testid", id), testId);
  expect(await rowCount(page, testId)).toBe(1);

  const visibleButtons = await parent.locator("button:visible").all();
  expect(visibleButtons).toHaveLength(5);
  for (const b of visibleButtons) {
    const box = (await b.boundingBox())!;
    expect(Math.round(box.width)).toBe(44);
    expect(Math.round(box.height)).toBe(44);
  }
  const rowBox = (await bar.locator("xpath=../..").boundingBox())!;
  for (const c of await parent.locator("button:visible, input:visible").all()) {
    const box = (await c.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
  }

  // Below sm (640px), Go-to-page is hidden and the 3 zoom buttons + Prev/Next share the row.
  await expect(page.getByTestId("book-preview-goto-input")).toBeHidden();
  await expect(page.getByTestId("book-preview-goto-submit")).toBeHidden();
  const zoomOut = page.getByTestId("book-preview-zoom-out");
  const zoomIn = page.getByTestId("book-preview-zoom-in");
  const zoomReset = page.getByTestId("book-preview-zoom-reset");
  const prevBtn = page.getByRole("button", { name: "Previous preview page" });
  const nextBtn = page.getByRole("button", { name: "Next preview page" });
  for (const btn of [zoomOut, zoomIn, zoomReset, prevBtn, nextBtn]) {
    await expect(btn).toBeVisible();
  }
  await expect(zoomOut).toBeDisabled();
  await expect(zoomReset).toBeDisabled();

  // Zoom label is visually hidden below sm but must stay in the DOM as the polite live region.
  await expect(page.getByTestId("book-preview-zoom-label")).not.toHaveCSS("display", "none");
  // Visually hidden (sr-only = 1x1 clipped), not merely present.
  const zoomBox = (await page.getByTestId("book-preview-zoom-label").boundingBox())!;
  expect(zoomBox.width).toBeLessThanOrEqual(1);
  // Icon-only below sm: the Prev/Next text spans are not rendered visibly.
  await expect(bar.locator("xpath=..").getByText("Prev", { exact: true })).toBeHidden();
  await expect(bar.locator("xpath=..").getByText("Next", { exact: true })).toBeHidden();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveAttribute("aria-live", "polite");

  // Phones keep native pinch-zoom alongside the zoom buttons.
  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-stage")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("book-preview-stage")).toHaveCSS("touch-action", "pan-y pinch-zoom");

  // Exercise mobile zoom buttons: Zoom In -> 135%, Zoom Out -> 100%, Zoom In -> Reset -> 100%.
  const previewViewport = page.getByTestId("book-preview-viewport");
  await zoomIn.click();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveText("135%");
  await expect(previewViewport).toHaveAttribute("data-zoom", "1.35");
  await expect(zoomOut).toBeEnabled();
  await expect(zoomReset).toBeEnabled();
  const overflowZoomed = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflowZoomed).toBe(false);

  await zoomOut.click();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveText("100%");
  await expect(previewViewport).toHaveAttribute("data-zoom", "1");

  await zoomIn.click();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveText("135%");
  await zoomReset.click();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveText("100%");
  await expect(zoomReset).toBeVisible();
  await expect(zoomReset).toBeDisabled();

  await parent.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/mobile-reader-controls.png" });
});

test("read-aloud controls fit one row with uniform 44x44px targets at 390px", async ({ page }) => {
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
    expect(Math.round(box.width)).toBe(44);
    expect(Math.round(box.height)).toBe(44);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
  }

  // Wider rate label (e.g., 1.25×) keeps exact 44x44px dimensions without overflowing or clipping.
  const speedBtn = page.getByTestId("read-aloud-speed");
  await speedBtn.click();
  await expect(speedBtn).toHaveText("1.25×");
  const speedBox = (await speedBtn.boundingBox())!;
  expect(Math.round(speedBox.width)).toBe(44);
  expect(Math.round(speedBox.height)).toBe(44);
  const speedClips = await speedBtn.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(speedClips).toBe(false);
  expect(await rowCount(page, "read-aloud-controls")).toBe(1);
  await page.getByTestId("book-preview-accessible-card").screenshot({ path: "test-results/mobile-read-aloud-controls.png" });
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
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(page.getByTestId("book-preview-zoom-label")).toHaveText("100%");
  await expect(reset).toBeVisible();
  await expect(reset).toBeDisabled();
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
    await expect(page.getByTestId("book-preview-goto-input")).toBeVisible();
    await expect(page.getByTestId("book-preview-goto-submit")).toBeVisible();
  });
});
