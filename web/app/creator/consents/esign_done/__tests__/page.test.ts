import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryCaptureMock = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({
  captureException: sentryCaptureMock,
}));

vi.mock("next/link", () => ({
  default: (props: Record<string, unknown> & { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href: props.href, className: props.className }, props.children),
}));

const getPortalSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../../src/lib/supabase-server", () => ({
  getPortalSession: getPortalSessionMock,
}));

const resolvePrimaryProductMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../../src/lib/primary-product", () => ({
  resolvePrimaryProduct: resolvePrimaryProductMock,
}));

const loadCreatorConsentRowsMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../../src/lib/creator-consents", () => ({
  loadCreatorConsentRows: loadCreatorConsentRowsMock,
}));

import EsignDonePage from "../page";

const RELEASE_SHA = "a".repeat(64);

describe("EsignDonePage", () => {
  beforeEach(() => {
    sentryCaptureMock.mockReset();
    getPortalSessionMock.mockReset();
    resolvePrimaryProductMock.mockReset();
    loadCreatorConsentRowsMock.mockReset();
    getPortalSessionMock.mockResolvedValue({ supabase: {} });
    resolvePrimaryProductMock.mockResolvedValue({
      product: { id: "p1", creator_id: "cr1", release_sha256: RELEASE_SHA },
      error: null,
    });
    loadCreatorConsentRowsMock.mockResolvedValue({ rows: [], error: null });
  });

  it("renders the pending state when no session exists without reporting an error", async () => {
    getPortalSessionMock.mockResolvedValueOnce(null);
    const html = renderToStaticMarkup(await EsignDonePage());
    expect(html).toContain("Finalising your signature");
    expect(html).not.toContain('role="alert"');
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it("renders the pending state when no primary product exists without reporting an error", async () => {
    resolvePrimaryProductMock.mockResolvedValueOnce({ product: null, error: null });
    const html = renderToStaticMarkup(await EsignDonePage());
    expect(html).toContain("Finalising your signature");
    expect(html).not.toContain('role="alert"');
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it("renders the pending state when C3 consent has not landed yet", async () => {
    loadCreatorConsentRowsMock.mockResolvedValueOnce({ rows: [], error: null });
    const html = renderToStaticMarkup(await EsignDonePage());
    expect(html).toContain("Finalising your signature");
    expect(html).not.toContain('role="alert"');
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it("renders the recorded state when C3 consent is active on the primary product", async () => {
    loadCreatorConsentRowsMock.mockResolvedValueOnce({
      rows: [
        {
          id: "c3_1",
          kind: "C3_revenue_split",
          decision: "given",
          product_id: "p1",
          supersedes: null,
          supersedes_ids: null,
          document_sha256: null,
        },
      ],
      error: null,
    });
    const html = renderToStaticMarkup(await EsignDonePage());
    expect(html).toContain("Revenue-split agreement signed");
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it("renders a read-failed state with reload hint and reports an Error with cause when the products query fails", async () => {
    const productError = { message: "products read timeout", code: "57014" };
    resolvePrimaryProductMock.mockResolvedValueOnce({ product: null, error: productError });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(await EsignDonePage());
      expect(html).not.toContain("Finalising your signature");
      expect(html).toContain('role="alert"');
      expect(html.toLowerCase()).toContain("reload");
      expect(consoleSpy).toHaveBeenCalledWith("[esign_done] products query failed:", "products read timeout");
      expect(sentryCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: "products read timeout", cause: productError }),
        { tags: { surface: "esign_done", query: "products" } },
      );
      expect(sentryCaptureMock.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("renders a read-failed state with reload hint and reports an Error with cause when the consents query fails", async () => {
    const consentsError = { message: "consents permission denied", code: "42501" };
    loadCreatorConsentRowsMock.mockResolvedValueOnce({ rows: [], error: consentsError });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(await EsignDonePage());
      expect(html).not.toContain("Finalising your signature");
      expect(html).toContain('role="alert"');
      expect(html.toLowerCase()).toContain("reload");
      expect(consoleSpy).toHaveBeenCalledWith("[esign_done] consents query failed:", "consents permission denied");
      expect(sentryCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: "consents permission denied", cause: consentsError }),
        { tags: { surface: "esign_done", query: "consents" } },
      );
      expect(sentryCaptureMock.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("renders a read-failed state with reload hint and reports an Error with cause when an unexpected error is thrown", async () => {
    const thrown = { message: "session check exploded" };
    getPortalSessionMock.mockRejectedValueOnce(thrown);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(await EsignDonePage());
      expect(html).not.toContain("Finalising your signature");
      expect(html).toContain('role="alert"');
      expect(html.toLowerCase()).toContain("reload");
      expect(consoleSpy).toHaveBeenCalledWith("[esign_done] C3 status check failed:", expect.any(Error));
      expect(sentryCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: "session check exploded", cause: thrown }),
        { tags: { surface: "esign_done", query: "c3" } },
      );
      expect(sentryCaptureMock.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
