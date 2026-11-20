// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL } from "../../payments/src/settings_registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const motionPropsLog = vi.hoisted(() => [] as Array<{ animate: unknown; transition: unknown }>);

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return {
    ...actual,
    motion: {
      ...actual.motion,
      span: (props: React.HTMLAttributes<HTMLSpanElement> & { animate?: unknown; transition?: unknown; initial?: unknown }) => {
        const { children, animate, transition, ...rest } = props;
        delete (rest as { initial?: unknown }).initial;
        motionPropsLog.push({ animate, transition });
        return React.createElement("span", rest, children);
      },
    },
  };
});

import { PreviewScrollCue } from "../src/components/storefront/preview-scroll-cue";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function stubReducedMotion(reduced: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reduced : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function mountCue() {
  const layout = DEFAULT_GLOBAL.storefront.product_layout;
  container = document.createElement("div");
  const targetSection = document.createElement("section");
  targetSection.id = layout.preview_section_id;
  const scrollIntoView = vi.fn();
  targetSection.scrollIntoView = scrollIntoView;
  container.appendChild(targetSection);
  const host = document.createElement("div");
  container.appendChild(host);
  document.body.appendChild(container);

  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(PreviewScrollCue, {
        targetId: layout.preview_section_id,
        label: layout.preview_cue_label,
        bounceDistancePx: layout.cue_bounce_distance_px,
        bounceDurationS: layout.cue_bounce_duration_s,
        bounceRepeatDelayS: layout.cue_bounce_repeat_delay_s,
      }),
    );
  });
  return { scrollIntoView };
}

beforeEach(() => {
  motionPropsLog.length = 0;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("PreviewScrollCue", () => {
  it("renders a keyboard-accessible button with aria-controls, focus ring, bounce animation, and smooth-scrolls on click", async () => {
    stubReducedMotion(false);
    const { scrollIntoView } = await mountCue();
    const layout = DEFAULT_GLOBAL.storefront.product_layout;
    const btn = container!.querySelector('button[data-testid="preview-scroll-cue"]') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.type).toBe("button");
    expect(btn!.getAttribute("aria-controls")).toBe(layout.preview_section_id);
    expect(btn!.textContent).toContain(layout.preview_cue_label);
    expect(btn!.className).toContain("focus-visible:outline");

    const latestMotion = motionPropsLog[motionPropsLog.length - 1];
    expect(latestMotion?.animate).toEqual({ y: [0, layout.cue_bounce_distance_px, 0] });

    await act(async () => {
      btn!.click();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("disables bounce animation and uses instant scroll when prefers-reduced-motion is reduce", async () => {
    stubReducedMotion(true);
    const { scrollIntoView } = await mountCue();
    const btn = container!.querySelector('button[data-testid="preview-scroll-cue"]') as HTMLButtonElement;

    const latestMotion = motionPropsLog[motionPropsLog.length - 1];
    expect(latestMotion?.animate).toEqual({ y: 0 });
    expect(latestMotion?.transition).toEqual({ duration: 0 });

    await act(async () => {
      btn.click();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });
});
