import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryCaptureMock = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({
  captureException: sentryCaptureMock,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const getPortalSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/lib/supabase-server", () => ({
  getPortalSession: getPortalSessionMock,
}));

const resolvePrimaryProductMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/lib/primary-product", () => ({
  resolvePrimaryProduct: resolvePrimaryProductMock,
}));

const loadCreatorConsentRowsMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/lib/creator-consents", () => ({
  loadCreatorConsentRows: loadCreatorConsentRowsMock,
}));

vi.mock("../consent-cards", () => ({
  default: () => React.createElement("div", null, "consent cards"),
}));

import ConsentsPage from "../page";

describe("ConsentsPage query failures", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sentryCaptureMock.mockClear();
    getPortalSessionMock.mockReset();
    resolvePrimaryProductMock.mockReset();
    loadCreatorConsentRowsMock.mockReset();
    getPortalSessionMock.mockResolvedValue({ supabase: {} });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("reports a products read failure to Sentry as an Error carrying the message", async () => {
    resolvePrimaryProductMock.mockResolvedValueOnce({ product: null, error: { message: "products unavailable" } });
    const html = renderToStaticMarkup(await ConsentsPage());
    expect(html).toContain('role="alert"');
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [captured, context] = sentryCaptureMock.mock.calls[0] as [unknown, unknown];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("products unavailable");
    expect(context).toEqual({ tags: { surface: "consents", query: "products" } });
  });

  it("reports a consents read failure to Sentry as an Error carrying the message", async () => {
    resolvePrimaryProductMock.mockResolvedValueOnce({
      product: { id: "p1", title: "Book", creator_id: "cr1", release_sha256: "a".repeat(64) },
      error: null,
    });
    loadCreatorConsentRowsMock.mockResolvedValueOnce({ rows: [], error: { message: "consents unavailable" } });
    const html = renderToStaticMarkup(await ConsentsPage());
    expect(html).toContain('role="alert"');
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [captured, context] = sentryCaptureMock.mock.calls[0] as [unknown, unknown];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("consents unavailable");
    expect(context).toEqual({ tags: { surface: "consents", query: "consents" } });
  });
});
