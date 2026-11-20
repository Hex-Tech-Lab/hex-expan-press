import { test, expect, devices, type Page } from "@playwright/test";
import { MOCK_HTTP_URL } from "./constants";

// Basic-voice guidance, WebKit only: iPhone profile (iOS steps) and desktop Safari (Mac steps).
// Real voice lists cannot be loaded in a test, so the mock reports the voices each device would report.
const PRODUCT_PATH = "/books/expanpress_house/sample_the_quiet_workshop";
const EXPECTED_MESSAGE =
  "Your device is using a basic voice. Apple offers a natural-sounding voice for free. Want to switch? It takes about 30 seconds.";
const DOWNLOAD_STEP = "Download a voice marked Premium or Enhanced (e.g. Ava or Zoe), then come back here.";

interface MockVoice {
  name: string;
  lang: string;
}

const BASIC_VOICES: MockVoice[] = [
  { name: "Samantha", lang: "en-US" },
  { name: "Daniel", lang: "en-GB" },
];
const ENHANCED_VOICE: MockVoice = { name: "Ava (Enhanced)", lang: "en-US" };

/** Installs a speechSynthesis stand-in whose voice list the test can change (window.__setVoices). */
async function installVoiceList(page: Page, voices: MockVoice[]) {
  await page.addInitScript((initial: MockVoice[]) => {
    let voiceList: MockVoice[] = initial;
    const listeners = new Set<() => void>();

    class FakeUtterance {
      text: string;
      constructor(text = "") {
        this.text = text;
      }
    }

    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      speak() {},
      cancel() {},
      pause() {},
      resume() {},
      getVoices() {
        return voiceList;
      },
      addEventListener(type: string, fn: () => void) {
        if (type === "voiceschanged") listeners.add(fn);
      },
      removeEventListener(type: string, fn: () => void) {
        if (type === "voiceschanged") listeners.delete(fn);
      },
    };

    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true, writable: true });
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true, writable: true });
    (window as unknown as Record<string, unknown>).__setVoices = (next: MockVoice[]) => {
      voiceList = next;
      listeners.forEach((fn) => fn());
    };
    // Changes the list without firing voiceschanged, as an engine that never sends the event would.
    (window as unknown as Record<string, unknown>).__setVoicesSilently = (next: MockVoice[]) => {
      voiceList = next;
    };
  }, voices);
}

async function openPreviewWithControls(page: Page) {
  const res = await page.goto(PRODUCT_PATH);
  expect(res?.status()).toBe(200);
  await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("book-preview-page-label")).toHaveText("Front cover · Page 1 of 8", { timeout: 30_000 });
  await page.getByRole("button", { name: "Next preview page" }).click();
  await expect(page.getByTestId("read-aloud-controls")).toBeVisible();
}

test.beforeEach(async ({ browserName }) => {
  test.skip(browserName !== "webkit", "Basic-voice guidance is checked in WebKit, the engine iOS and macOS Safari use.");
  await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
});

// Device profiles carry defaultBrowserType, which Playwright refuses inside a describe group.
// The webkit project already picks the engine, so only the viewport and user-agent fields are kept.
function withoutBrowserType(profile: (typeof devices)[string]) {
  const { defaultBrowserType: _engine, ...rest } = profile;
  return rest;
}

test.describe("iPhone (iOS steps)", () => {
  test.use(withoutBrowserType(devices["iPhone 13"]));

  test("iPhone with only basic voices shows the guide; Show me how lists four iOS steps", async ({ page }) => {
    await installVoiceList(page, BASIC_VOICES);
    await openPreviewWithControls(page);

    const guide = page.getByTestId("basic-voice-guide");
    await expect(guide).toBeVisible();
    await expect(guide).toHaveAttribute("role", "region");
    await expect(guide.getByText("Your device is using a basic voice.")).toBeVisible();
    // The region is named by its message, not by a generic label.
    await expect(page.getByRole("region", { name: /basic voice/ })).toBeVisible();

    await page.getByTestId("basic-voice-guide-show-steps").click();
    const steps = page.getByTestId("basic-voice-guide-steps");
    await expect(steps).toBeVisible();
    await expect(steps.locator("li")).toHaveCount(4);
    await expect(steps.locator("li").nth(0)).toHaveText("Open Settings.");
    await expect(steps.locator("li").nth(3)).toHaveText(DOWNLOAD_STEP);
    // Focus moves to the steps list so a screen reader reads them.
    await expect(steps).toBeFocused();

    const copy = (await guide.textContent()) ?? "";
    expect(copy).not.toMatch(/we (will )?download/i);
  });

  test("Not now hides the guide, returns focus to Read Aloud, and stays hidden for this visit", async ({ page }) => {
    await installVoiceList(page, BASIC_VOICES);
    await openPreviewWithControls(page);

    await page.getByTestId("basic-voice-guide-dismiss").click();
    await expect(page.getByTestId("basic-voice-guide")).toHaveCount(0);
    await expect(page.getByTestId("read-aloud-toggle")).toBeFocused();

    // Same tab: sessionStorage keeps the choice across a reload.
    await page.reload();
    await page.getByTestId("book-preview-section").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("read-aloud-controls")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("basic-voice-guide")).toHaveCount(0);
  });

  test("Try the voice again re-reads the list; a still-basic list keeps the card and says so", async ({ page }) => {
    await installVoiceList(page, BASIC_VOICES);
    await openPreviewWithControls(page);
    await expect(page.getByTestId("basic-voice-guide")).toBeVisible();

    await page.getByTestId("basic-voice-guide-retry").click();
    await expect(page.getByTestId("basic-voice-guide")).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(
      "Still a basic voice. Download a voice marked Premium or Enhanced, then try again.",
    );
  });

  test("an engine that never fires voiceschanged: Try the voice again finds the new Enhanced voice and hides the guide", async ({ page }) => {
    await installVoiceList(page, BASIC_VOICES);
    await openPreviewWithControls(page);
    await expect(page.getByTestId("basic-voice-guide")).toBeVisible();

    // Ava is installed, but the list changes silently: only the retry re-reads it.
    await page.evaluate((voice: MockVoice) => {
      const setSilently = (window as unknown as { __setVoicesSilently: (v: MockVoice[]) => void }).__setVoicesSilently;
      setSilently([...(window.speechSynthesis.getVoices() as MockVoice[]), voice]);
    }, ENHANCED_VOICE);
    await page.getByTestId("basic-voice-guide-retry").click();
    await expect(page.getByTestId("basic-voice-guide")).toHaveCount(0);
    await expect(page.getByTestId("read-aloud-toggle")).toBeFocused();
  });

  test("an Enhanced voice that the engine announces with voiceschanged hides the guide without a retry", async ({ page }) => {
    await installVoiceList(page, BASIC_VOICES);
    await openPreviewWithControls(page);
    await expect(page.getByTestId("basic-voice-guide")).toBeVisible();

    await page.evaluate((voice: MockVoice) => {
      const setVoices = (window as unknown as { __setVoices: (v: MockVoice[]) => void }).__setVoices;
      setVoices([...(window.speechSynthesis.getVoices() as MockVoice[]), voice]);
    }, ENHANCED_VOICE);
    await expect(page.getByTestId("basic-voice-guide")).toHaveCount(0);
  });

  test("an iPhone with an Enhanced voice already installed never sees the guide", async ({ page }) => {
    await installVoiceList(page, [...BASIC_VOICES, ENHANCED_VOICE]);
    await openPreviewWithControls(page);
    await expect(page.getByTestId("read-aloud-controls")).toBeVisible();
    await expect(page.getByTestId("basic-voice-guide")).toHaveCount(0);
  });
});

test.describe("desktop Safari on macOS (Mac steps)", () => {
  test.use(withoutBrowserType(devices["Desktop Safari"]));

  test("Safari on a Mac with only basic voices shows the guide with the Mac steps", async ({ page }) => {
    await installVoiceList(page, BASIC_VOICES);
    await openPreviewWithControls(page);

    const guide = page.getByTestId("basic-voice-guide");
    await expect(guide).toBeVisible();
    await expect(guide.getByText(EXPECTED_MESSAGE)).toBeVisible();

    await page.getByTestId("basic-voice-guide-show-steps").click();
    const steps = page.getByTestId("basic-voice-guide-steps");
    await expect(steps.locator("li")).toHaveCount(4);
    await expect(steps.locator("li").nth(0)).toHaveText("Open System Settings.");
    await expect(steps.locator("li").nth(1)).toHaveText("Click Accessibility, then Spoken Content.");
    await expect(steps.locator("li").nth(2)).toHaveText("Next to System Voice, choose Manage Voices.");
    await expect(steps.locator("li").nth(3)).toHaveText(DOWNLOAD_STEP);
    await expect(steps).toBeFocused();
  });

  test("Safari on a Mac with an Enhanced voice installed never sees the guide", async ({ page }) => {
    await installVoiceList(page, [...BASIC_VOICES, ENHANCED_VOICE]);
    await openPreviewWithControls(page);
    await expect(page.getByTestId("read-aloud-controls")).toBeVisible();
    await expect(page.getByTestId("basic-voice-guide")).toHaveCount(0);
  });
});
