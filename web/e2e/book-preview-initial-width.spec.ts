import { test, expect, type Page } from "@playwright/test";

// Regression: the flipbook was constructed while its host was still `sr-only` (1px) and never
// re-synced when the layout settled, so the canvas bitmap came out horizontally compressed.
// Assert the drawn bitmap keeps the PDF page aspect at first render, with the text panel open and closed.

const SAMPLE_URL = "/books/expanpress_house/sample_the_quiet_workshop";
const ASPECT_TOLERANCE = 0.03;

const VIEWPORTS = [
  { name: "ipad-pro-11-portrait", width: 834, height: 1194 },
  { name: "desktop-1560", width: 1560, height: 900 },
] as const;

/** Two animation frames: lets the layout settle without a timeout. */
function settleFrames(page: Page) {
  return page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Bitmap and CSS-box size of the flipbook canvas, plus the orientation page-flip chose. */
function readCanvas(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="book-preview-stage"] canvas');
    const host = document.querySelector<HTMLElement>('[data-testid="book-preview-viewport"] [data-orientation]');
    if (!canvas || !host) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      bitmapW: canvas.width,
      bitmapH: canvas.height,
      cssW: rect.width,
      cssH: rect.height,
      orientation: host.getAttribute("data-orientation"),
    };
  });
}

/** Page aspect of the preview PDF, read from its first MediaBox (the same page size pdf.js rasterizes). */
async function pdfPageAspect(page: Page, baseURL: string | undefined): Promise<number> {
  const pdfPath = await page.evaluate(
    () => performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\.pdf(\?|$)/i.test(n)) ?? null,
  );
  expect(pdfPath, "preview PDF was requested by the previewer").not.toBeNull();
  const res = await fetch(new URL(pdfPath as string, baseURL).toString());
  expect(res.ok).toBe(true);
  const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
  const box = /\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(text);
  expect(box, "PDF declares a MediaBox").not.toBeNull();
  const [x0, y0, x1, y1] = box!.slice(1).map(Number);
  return (x1 - x0) / (y1 - y0);
}

/** Expected drawn aspect: one page in portrait, a two-page spread in landscape. */
function expectedAspect(orientation: string | null, pageAspect: number): number {
  return orientation === "portrait" ? pageAspect : 2 * pageAspect;
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / expected;
}

for (const vp of VIEWPORTS) {
  test(`flipbook bitmap keeps PDF page aspect on first render (${vp.name})`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const res = await page.goto(SAMPLE_URL);
    expect(res?.status()).toBe(200);

    await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", {
      timeout: 30_000,
    });
    await settleFrames(page);

    const pageAspect = await pdfPageAspect(page, baseURL);
    const settled = await readCanvas(page);
    expect(settled).not.toBeNull();
    const want = expectedAspect(settled!.orientation, pageAspect);
    expect(settled!.bitmapW).toBeGreaterThan(0);
    expect(relativeError(settled!.bitmapW / settled!.bitmapH, want)).toBeLessThan(ASPECT_TOLERANCE);
    expect(relativeError(settled!.cssW / settled!.cssH, want)).toBeLessThan(ASPECT_TOLERANCE);

    // Same check with the text panel opened: the drawn page must still keep its aspect.
    await page.getByTestId("book-preview-accessible-toggle").click();
    await settleFrames(page);
    const withPanel = await readCanvas(page);
    expect(withPanel).not.toBeNull();
    const wantWithPanel = expectedAspect(withPanel!.orientation, pageAspect);
    expect(relativeError(withPanel!.bitmapW / withPanel!.bitmapH, wantWithPanel)).toBeLessThan(ASPECT_TOLERANCE);
  });

  // The product has no open-at-load state: the text panel opens only from its toggle or read-aloud. This variant
  // opens it as soon as the page label appears, before the first frames settle, to cover the early-open ordering.
  test(`flipbook bitmap keeps PDF page aspect when text panel opens during load (${vp.name})`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(SAMPLE_URL);
    await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", {
      timeout: 30_000,
    });
    await page.getByTestId("book-preview-accessible-toggle").click();
    await settleFrames(page);

    const pageAspect = await pdfPageAspect(page, baseURL);
    const settled = await readCanvas(page);
    expect(settled).not.toBeNull();
    const want = expectedAspect(settled!.orientation, pageAspect);
    expect(relativeError(settled!.bitmapW / settled!.bitmapH, want)).toBeLessThan(ASPECT_TOLERANCE);
    expect(relativeError(settled!.cssW / settled!.cssH, want)).toBeLessThan(ASPECT_TOLERANCE);
  });

  // Container-only resize: the host width changes after ready with no window resize. page-flip re-syncs on window
  // resize itself, so only the container observer (ResizeObserver in book-previewer.tsx) can pass this case.
  test(`flipbook bitmap re-syncs when its container width changes without a window resize (${vp.name})`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(SAMPLE_URL);
    await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", {
      timeout: 30_000,
    });
    await settleFrames(page);
    const before = await readCanvas(page);
    expect(before).not.toBeNull();

    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-testid="book-preview-viewport"] [data-orientation]');
      if (host) host.style.width = "70%";
    });
    await settleFrames(page);
    await settleFrames(page);

    const pageAspect = await pdfPageAspect(page, baseURL);
    const settled = await readCanvas(page);
    expect(settled).not.toBeNull();
    // Without the container observer, page-flip keeps the bitmap it sized at load: this width would not change.
    expect(settled!.bitmapW).not.toBe(before!.bitmapW);
    const want = expectedAspect(settled!.orientation, pageAspect);
    expect(relativeError(settled!.bitmapW / settled!.bitmapH, want)).toBeLessThan(ASPECT_TOLERANCE);
    expect(relativeError(settled!.cssW / settled!.cssH, want)).toBeLessThan(ASPECT_TOLERANCE);
  });
}
