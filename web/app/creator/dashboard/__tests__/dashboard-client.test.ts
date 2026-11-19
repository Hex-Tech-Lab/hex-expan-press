// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../actions", () => ({
  startPublisherAgreementAction: vi.fn(),
  signOutAction: vi.fn(),
}));

vi.mock("framer-motion", () => {
  const MOTION_ONLY_PROPS = new Set([
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
    "whileTap",
    "whileHover",
    "layout",
  ]);
  const strip = (props: Record<string, unknown>) => {
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      if (!MOTION_ONLY_PROPS.has(key)) rest[key] = props[key];
    }
    return rest;
  };
  const m = new Proxy(
    {},
    {
      get: (_target, tag) => {
        if (typeof tag !== "string") return undefined;
        return (props: Record<string, unknown>) => React.createElement(tag, strip(props));
      },
    },
  );
  return {
    m,
    AnimatePresence: (props: { children?: React.ReactNode }) => props.children ?? null,
    useReducedMotion: () => true,
  };
});

vi.mock("@iconify/react", () => ({
  Icon: () => null,
  addCollection: vi.fn(),
}));

vi.mock("@iconify-json/lucide/icons.json", () => ({
  default: {},
}));

import { GLOBAL } from "../../../../../payments/src/settings_registry";
import DashboardClient, { type DashboardClientProps } from "../dashboard-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderDashboard(overrides: Partial<DashboardClientProps> = {}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const props: DashboardClientProps = {
    name: "Ada Lovelace",
    email: "ada@expanpress.com",
    supportEmail: GLOBAL.email.support,
    answersCount: 1,
    answersTarget: 3,
    hasC1: true,
    hasC2: true,
    hasC3: false,
    journeyActive: 1,
    ...overrides,
  };
  await act(async () => {
    root!.render(React.createElement(DashboardClient, props));
  });
  return container;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

describe("DashboardClient actionError banner", () => {
  it("renders the load_failed alert banner when actionError is load_failed", async () => {
    const el = await renderDashboard({ actionError: "load_failed" });
    const alert = el.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe(
      "We could not load your agreement status. Please reload. If it keeps happening, contact support.",
    );
  });

  it("renders no alert banner when actionError is undefined", async () => {
    const el = await renderDashboard();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});
