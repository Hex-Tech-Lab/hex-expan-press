import { test, expect, type Page } from "@playwright/test";
import { MOCK_HTTP_URL } from "./constants";

const PRODUCT_PATH = "/books/expanpress_house/sample_the_quiet_workshop";

async function installMockSpeechSynthesis(page: Page) {
  await page.addInitScript(() => {
    const log = {
      spoken: [] as Array<{ text: string; rate: number }>,
      cancels: 0,
      pauses: 0,
      resumes: 0,
    };
    const active: Array<{ instance: FakeUtterance }> = [];

    class FakeUtterance {
      text: string;
      rate = 1;
      onstart: ((ev: Event) => void) | null = null;
      onend: ((ev: Event) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor(text = "") {
        this.text = text;
      }
    }

    let paused = false;
    let speaking = false;

    const synth = {
      get paused() {
        return paused;
      },
      get speaking() {
        return speaking;
      },
      get pending() {
        return false;
      },
      speak(u: FakeUtterance) {
        speaking = true;
        paused = false;
        log.spoken.push({ text: u.text, rate: u.rate });
        active.push({ instance: u });
        setTimeout(() => {
          u.onstart?.(new Event("start"));
        }, 0);
      },
      cancel() {
        log.cancels += 1;
        speaking = false;
        paused = false;
        active.length = 0;
      },
      pause() {
        log.pauses += 1;
        paused = true;
      },
      resume() {
        log.resumes += 1;
        paused = false;
      },
      getVoices() {
        return [];
      },
    };

    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: FakeUtterance,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: synth,
      configurable: true,
      writable: true,
    });
    (window as unknown as Record<string, unknown>).__speechMock = {
      log,
      finishCurrent() {
        const current = active.shift();
        if (current) {
          current.instance.onend?.(new Event("end"));
        }
      },
    };
  });
}

async function installUnsupportedSpeechSynthesis(page: Page) {
  await page.addInitScript(() => {
    try {
      delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    } catch {
      Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    }
    try {
      delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
    } catch {
      Object.defineProperty(window, "SpeechSynthesisUtterance", { value: undefined, configurable: true });
    }
  });
}

test.beforeEach(async () => {
  await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1560, height: 940 },
]) {
  test(`Read Aloud & structured accessible text work end-to-end at ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.setViewportSize(viewport);
    await installMockSpeechSynthesis(page);

    const res = await page.goto(PRODUCT_PATH);
    expect(res?.status()).toBe(200);

    const previewSection = page.getByTestId("book-preview-section");
    await previewSection.scrollIntoViewIfNeeded();
    await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", {
      timeout: 30_000,
    });

    // Turn to page 2 (Contents / Title page) so structured headings/lists appear
    await page.getByRole("button", { name: "Next preview page" }).click();
    if (viewport.width === 390) {
      await expect(page.getByTestId("book-preview-page-label")).toHaveText("Page 2 of 8");
    } else {
      await expect(page.getByTestId("book-preview-page-label")).toHaveText("Pages 2–3 of 8");
    }

    const card = page.getByTestId("book-preview-accessible-card");
    const toggle = page.getByTestId("book-preview-accessible-toggle");
    const controls = page.getByTestId("read-aloud-controls");
    const playBtn = page.getByTestId("read-aloud-toggle");
    const speedBtn = page.getByTestId("read-aloud-speed");

    await expect(card).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(controls).toBeVisible();
    await expect(playBtn).toHaveAttribute("aria-label", "Read preview text aloud");
    await expect(speedBtn).toHaveText("1×");

    // Verify no horizontal overflow and clean header alignment inside card
    const layoutMetrics = await page.evaluate(() => {
      const cardEl = document.querySelector('[data-testid="book-preview-accessible-card"]')!;
      const toggleEl = document.querySelector('[data-testid="book-preview-accessible-toggle"]')!;
      const controlsEl = document.querySelector('[data-testid="read-aloud-controls"]')!;
      const cRect = cardEl.getBoundingClientRect();
      const tRect = toggleEl.getBoundingClientRect();
      const rRect = controlsEl.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        toggleInside: tRect.left >= cRect.left - 1 && tRect.right <= cRect.right + 1,
        controlsInside: rRect.left >= cRect.left - 1 && rRect.right <= cRect.right + 1,
      };
    });
    expect(layoutMetrics.overflow).toBe(false);
    expect(layoutMetrics.toggleInside).toBe(true);
    expect(layoutMetrics.controlsInside).toBe(true);

    // Clicking Play auto-expands panel and highlights active sentence
    await playBtn.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(playBtn).toHaveAttribute("aria-label", "Pause reading aloud");
    await expect(page.getByTestId("read-aloud-stop")).toBeVisible();

    const textPanel = page.getByTestId("book-preview-accessible-text");
    await expect(textPanel).toBeVisible();
    expect(await textPanel.locator("h3, h4").count()).toBeGreaterThan(0);
    if (viewport.width === 1560) {
      expect(await textPanel.locator("ul > li").count()).toBeGreaterThan(0);
    }

    const activeSentence = textPanel.locator('[data-testid="read-aloud-sentence"][data-active="true"]');
    await expect(activeSentence).toHaveCount(1);

    // Pause -> Resume -> Speed cycle -> Stop
    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Resume reading aloud");
    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Pause reading aloud");

    await speedBtn.click();
    await expect(speedBtn).toHaveText("1.25×");
    await speedBtn.click();
    await expect(speedBtn).toHaveText("1.5×");
    await speedBtn.click();
    await expect(speedBtn).toHaveText("0.75×");
    await speedBtn.click();
    await expect(speedBtn).toHaveText("1×");

    await page.getByTestId("read-aloud-stop").click();
    await expect(playBtn).toHaveAttribute("aria-label", "Read preview text aloud");
    await expect(page.getByTestId("read-aloud-stop")).toHaveCount(0);

    // Reduced-motion verification: highlight transition collapses under prefers-reduced-motion: reduce
    await page.emulateMedia({ reducedMotion: "reduce" });
    await playBtn.click();
    const reducedDuration = await textPanel
      .locator('[data-testid="read-aloud-sentence"][data-active="true"]')
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(["0s", "0.00001s", "0.01ms", "1e-05s"].some((prefix) => reducedDuration.startsWith(prefix))).toBe(true);

    // Collapsing stops playback
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(playBtn).toHaveAttribute("aria-label", "Read preview text aloud");

    // pagehide stops playback
    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Pause reading aloud");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect(playBtn).toHaveAttribute("aria-label", "Read preview text aloud");

    expect(errors).toEqual([]);
  });
}

test("Read Aloud controls remain hidden when speechSynthesis is unsupported", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installUnsupportedSpeechSynthesis(page);

  const res = await page.goto(PRODUCT_PATH);
  expect(res?.status()).toBe(200);
  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", {
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "Next preview page" }).click();
  await expect(page.getByTestId("book-preview-accessible-toggle")).toBeVisible();
  await expect(page.getByTestId("read-aloud-controls")).toHaveCount(0);

  await page.getByTestId("book-preview-accessible-toggle").click();
  await expect(page.getByTestId("book-preview-accessible-text")).toBeVisible();
});
