import { test, expect, type Page } from "@playwright/test";
import { MOCK_HTTP_URL } from "./constants";

const PRODUCT_PATH = "/books/expanpress_house/sample_the_quiet_workshop";

interface MockVoice {
  name: string;
  lang: string;
}

interface MockSpeechOptions {
  voices: MockVoice[];
  /** Fire word boundary events, as voices that report them do. */
  boundaries: boolean;
}

const NATURAL_VOICE: MockVoice = { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US" };
const LEGACY_VOICE: MockVoice = { name: "Microsoft David - English (United States)", lang: "en-US" };
const NO_BOUNDARY_VOICES: MockSpeechOptions = { voices: [], boundaries: false };

async function installMockSpeechSynthesis(page: Page, options: MockSpeechOptions = NO_BOUNDARY_VOICES) {
  await page.addInitScript((opts: MockSpeechOptions) => {
    const log = {
      spoken: [] as Array<{ text: string; rate: number; voice: string | null }>,
      cancels: 0,
      pauses: 0,
      resumes: 0,
      boundaries: 0,
    };
    const active: Array<{ instance: FakeUtterance }> = [];

    class FakeUtterance {
      text: string;
      rate = 1;
      voice: { name: string } | null = null;
      onboundary: ((ev: { charIndex: number }) => void) | null = null;
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
        log.spoken.push({ text: u.text, rate: u.rate, voice: u.voice?.name ?? null });
        active.push({ instance: u });
        setTimeout(() => {
          u.onstart?.(new Event("start"));
          if (opts.boundaries) {
            // Second word starts after the first space, as a boundary-reporting voice would say.
            log.boundaries += 1;
            u.onboundary?.({ charIndex: u.text.indexOf(" ") + 1 });
          }
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
        return opts.voices;
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
  }, options);
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
    await expect(playBtn).toHaveAttribute("aria-label", "Read aloud: preview text");
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
    await expect(playBtn).toHaveAttribute("aria-label", "Read aloud: preview text");
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
    await expect(playBtn).toHaveAttribute("aria-label", "Read aloud: preview text");

    // pagehide stops playback
    await playBtn.click();
    await expect(playBtn).toHaveAttribute("aria-label", "Pause reading aloud");
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect(playBtn).toHaveAttribute("aria-label", "Read aloud: preview text");

    expect(errors).toEqual([]);
  });
}

test("Read Aloud controls remain hidden when neither pre-baked audio nor speechSynthesis is supported", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/timings.json", (route) => route.abort());
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

type MockWindow = Window & {
  __speechMock: {
    log: {
      spoken: Array<{ text: string; rate: number; voice: string | null }>;
      cancels: number;
      boundaries: number;
    };
  };
};

async function openPreviewSpread(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const res = await page.goto(PRODUCT_PATH);
  expect(res?.status()).toBe(200);
  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Next preview page" }).click();
  // Wait for the turn to settle (the label updates when the flip animation ends) before any play click.
  const settledLabel = viewport.width === 390 ? "Page 2 of 8" : "Pages 2–3 of 8";
  await expect(page.getByTestId("book-preview-page-label")).toHaveText(settledLabel);
  await expect(page.getByTestId("read-aloud-controls")).toBeVisible();
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1560, height: 940 },
]) {
  test(`first click starts speech synchronously with no voices loaded, without cancel, at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.route("**/timings.json", (route) => route.abort());
    await installMockSpeechSynthesis(page, NO_BOUNDARY_VOICES);
    await openPreviewSpread(page, viewport);

    // One click, no wait: Firefox used to need one or two clicks before speech started.
    await page.getByTestId("read-aloud-toggle").click();
    const seen = await page.evaluate(() => {
      const { log } = (window as unknown as MockWindow).__speechMock;
      return { spoken: log.spoken.length, cancels: log.cancels, voice: log.spoken[0]?.voice ?? null };
    });
    expect(seen.spoken).toBe(1);
    expect(seen.cancels).toBe(0);
    expect(seen.voice).toBeNull();
    await expect(page.getByTestId("read-aloud-toggle")).toHaveAttribute("data-playback-state", "playing");
  });

  test(`browser voice ranking picks the natural voice over the legacy one at ${viewport.width}px`, async ({ page }) => {
    await page.route("**/timings.json", (route) => route.abort());
    await installMockSpeechSynthesis(page, { voices: [LEGACY_VOICE, NATURAL_VOICE], boundaries: false });
    await openPreviewSpread(page, viewport);

    await page.getByTestId("read-aloud-toggle").click();
    await expect(page.getByTestId("read-aloud-toggle")).toHaveAttribute("data-playback-state", "playing");
    const voices = await page.evaluate(() => (window as unknown as MockWindow).__speechMock.log.spoken.map((s) => s.voice));
    expect(voices.length).toBeGreaterThan(0);
    for (const voice of voices) expect(voice).toBe(NATURAL_VOICE.name);
  });

  test(`speed change mid-sentence resumes from the last word boundary at ${viewport.width}px`, async ({ page }) => {
    await page.route("**/timings.json", (route) => route.abort());
    await installMockSpeechSynthesis(page, { voices: [NATURAL_VOICE], boundaries: true });
    await openPreviewSpread(page, viewport);

    await page.getByTestId("read-aloud-toggle").click();
    await page.waitForFunction(() => (window as unknown as MockWindow).__speechMock.log.boundaries >= 1);
    const before = await page.evaluate(() => (window as unknown as MockWindow).__speechMock.log.spoken[0]);

    await page.getByTestId("read-aloud-speed").click();
    await expect(page.getByTestId("read-aloud-speed")).toHaveText("1.25×");

    const spoken = await page.evaluate(() => (window as unknown as MockWindow).__speechMock.log.spoken);
    expect(spoken).toHaveLength(2);
    expect(spoken[1].rate).toBe(1.25);
    // Continues from the second word (the last boundary), not from the start of the sentence.
    expect(spoken[1].text).toBe(before.text.slice(before.text.indexOf(" ") + 1));
    expect(spoken[1].text).not.toBe(before.text);
  });
}

test("pre-baked Walter Opus/MP3 + timings.json pre-fetches manifest, downloads zero audio until tap, and updates playbackRate with preservesPitch=true", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1560, height: 940 });
  await installUnsupportedSpeechSynthesis(page);
  const audioByteRequests: string[] = [];
  page.on("request", (req) => {
    if (/\.(?:webm|mp3)(?:$|\?)/i.test(req.url())) {
      audioByteRequests.push(req.url());
    }
  });
  await page.addInitScript(() => {
    const audioEvents: Array<{ src: string; preload: string; rate: number; preservesPitch: boolean; action: string }> = [];
    const createdAudios: HTMLAudioElement[] = [];
    const OrigAudio = window.Audio;
    window.Audio = function PatchedAudio(src?: string) {
      const el = new OrigAudio(src);
      createdAudios.push(el);
      return el;
    } as unknown as typeof Audio;
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function patchedPlay(this: HTMLMediaElement) {
      audioEvents.push({
        src: this.currentSrc || this.getAttribute("src") || "",
        preload: this.preload,
        rate: this.playbackRate,
        preservesPitch: Boolean(this.preservesPitch),
        action: "play",
      });
      return origPlay.call(this).catch((err) => {
        console.warn("[e2e] audio.play suppressed in headless probe:", err);
      });
    };
    (window as unknown as Record<string, unknown>).__audioEvents = audioEvents;
    (window as unknown as Record<string, unknown>).__createdAudios = createdAudios;
  });

  const manifestPromise = page.waitForResponse((res) => res.url().endsWith("/timings.json") && res.status() === 200);
  const res = await page.goto(PRODUCT_PATH);
  expect(res?.status()).toBe(200);
  await manifestPromise;

  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("read-aloud-controls")).toBeVisible();

  await page.getByRole("button", { name: "Next preview page" }).click();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Pages 2–3 of 8");
  // Zero audio bytes downloaded prior to clicking Play
  expect(audioByteRequests).toEqual([]);

  await page.getByTestId("read-aloud-toggle").click();
  await expect(page.getByTestId("read-aloud-toggle")).toHaveAttribute("data-playback-state", "playing");
  await expect(page.getByTestId("book-preview-accessible-text").locator('[data-testid="read-aloud-sentence"][data-active="true"]')).toHaveCount(1);

  await page.getByTestId("read-aloud-speed").click();
  await expect(page.getByTestId("read-aloud-speed")).toHaveText("1.25×");

  const audioState = await page.evaluate(() => {
    const win = window as unknown as {
      __audioEvents: Array<{ src: string; preload: string; rate: number; preservesPitch: boolean; action: string }>;
      __createdAudios: HTMLAudioElement[];
    };
    const audio = win.__createdAudios[0];
    return {
      events: win.__audioEvents,
      currentRate: audio?.playbackRate ?? null,
      preservesPitch: Boolean(audio?.preservesPitch),
      preload: audio?.preload ?? null,
    };
  });
  expect(audioState.events.length).toBe(1);
  expect(audioState.events[0].src).toContain("/books/audio/sample_the_quiet_workshop/page-02.webm");
  expect(audioState.events[0].preload).toBe("none");
  expect(audioState.events[0].preservesPitch).toBe(true);
  expect(audioState.preload).toBe("none");
  expect(audioState.currentRate).toBe(1.25);
  expect(audioState.preservesPitch).toBe(true);
});
