import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryCaptureMock = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({
  captureException: sentryCaptureMock,
}));

const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
);
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
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

const dashboardClientMock = vi.hoisted(() => vi.fn(() => null));
vi.mock("../dashboard-client", () => ({
  default: dashboardClientMock,
}));

import DashboardPage from "../page";

const RELEASE_SHA = "a".repeat(64);

type QueryResult = { data?: unknown; error: { message: string } | null };
type Tables = "profiles" | "review_items" | "review_answers";

/** A chainable PostgREST-style builder that resolves to `result` when awaited. */
function query(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit", "maybeSingle"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function supabaseWith(overrides: Partial<Record<Tables, QueryResult>> = {}) {
  const defaults: Record<Tables, QueryResult> = {
    profiles: { data: { full_name: "Ada Creator", email: "ada@creator.test" }, error: null },
    review_items: { data: [], error: null },
    review_answers: { data: [], error: null },
  };
  return {
    from: (table: string) => query({ ...defaults, ...overrides }[table as Tables] ?? { data: [], error: null }),
  };
}

async function renderDashboard(): Promise<string> {
  return renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve({}) }));
}

describe("DashboardPage", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sentryCaptureMock.mockClear();
    dashboardClientMock.mockClear();
    redirectMock.mockClear();
    getPortalSessionMock.mockReset();
    resolvePrimaryProductMock.mockReset();
    loadCreatorConsentRowsMock.mockReset();
    getPortalSessionMock.mockResolvedValue({
      user: { id: "u1", email: "creator@creator.test" },
      supabase: supabaseWith(),
    });
    resolvePrimaryProductMock.mockResolvedValue({
      product: { id: "p1", creator_id: "cr1", release_sha256: RELEASE_SHA },
      error: null,
    });
    loadCreatorConsentRowsMock.mockResolvedValue({ rows: [], error: null });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("redirects to sign-in without rendering data when there is no session", async () => {
    getPortalSessionMock.mockResolvedValueOnce(null);
    await expect(renderDashboard()).rejects.toThrow("REDIRECT:/creator/signin");
    expect(dashboardClientMock).not.toHaveBeenCalled();
  });

  it("renders the dashboard client and reports nothing to Sentry when every read succeeds", async () => {
    const html = await renderDashboard();
    expect(html).not.toContain('role="alert"');
    expect(dashboardClientMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it("renders the failure UI, never the dashboard, when the profiles read fails", async () => {
    getPortalSessionMock.mockResolvedValueOnce({
      user: { id: "u1", email: "creator@creator.test" },
      supabase: supabaseWith({ profiles: { data: null, error: { message: "permission denied for table profiles" } } }),
    });
    const html = await renderDashboard();
    expect(html).toContain('role="alert"');
    expect(html).toContain("load your dashboard");
    expect(dashboardClientMock).not.toHaveBeenCalled();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [captured, context] = sentryCaptureMock.mock.calls[0] as [unknown, unknown];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("permission denied for table profiles");
    expect(context).toEqual({ tags: { surface: "dashboard", query: "profiles" } });
  });

  it("renders the failure UI and reports the products read when the primary product lookup fails", async () => {
    resolvePrimaryProductMock.mockResolvedValueOnce({ product: null, error: { message: "products unavailable" } });
    const html = await renderDashboard();
    expect(html).toContain('role="alert"');
    expect(dashboardClientMock).not.toHaveBeenCalled();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [captured, context] = sentryCaptureMock.mock.calls[0] as [unknown, unknown];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("products unavailable");
    expect(context).toEqual({ tags: { surface: "dashboard", query: "products" } });
  });

  it("renders the failure UI and reports the review_items read when it fails", async () => {
    getPortalSessionMock.mockResolvedValueOnce({
      user: { id: "u1", email: "creator@creator.test" },
      supabase: supabaseWith({ review_items: { data: null, error: { message: "review_items timeout" } } }),
    });
    const html = await renderDashboard();
    expect(html).toContain('role="alert"');
    expect(dashboardClientMock).not.toHaveBeenCalled();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [captured, context] = sentryCaptureMock.mock.calls[0] as [unknown, unknown];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("review_items timeout");
    expect(context).toEqual({ tags: { surface: "dashboard", query: "review_items" } });
  });

  it("renders the failure UI and reports the review_answers read when it fails", async () => {
    getPortalSessionMock.mockResolvedValueOnce({
      user: { id: "u1", email: "creator@creator.test" },
      supabase: supabaseWith({
        review_items: { data: [{ id: "i1", product_id: "p1", code: "A1" }], error: null },
        review_answers: { data: null, error: { message: "review_answers timeout" } },
      }),
    });
    const html = await renderDashboard();
    expect(html).toContain('role="alert"');
    expect(dashboardClientMock).not.toHaveBeenCalled();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [captured, context] = sentryCaptureMock.mock.calls[0] as [unknown, unknown];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("review_answers timeout");
    expect(context).toEqual({ tags: { surface: "dashboard", query: "review_answers" } });
  });

  it("renders the failure UI and reports the consents read when the consent load fails", async () => {
    loadCreatorConsentRowsMock.mockResolvedValueOnce({ rows: [], error: { message: "consents unavailable" } });
    const html = await renderDashboard();
    expect(html).toContain('role="alert"');
    expect(dashboardClientMock).not.toHaveBeenCalled();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [captured, context] = sentryCaptureMock.mock.calls[0] as [unknown, unknown];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("consents unavailable");
    expect(context).toEqual({ tags: { surface: "dashboard", query: "consents" } });
  });

  it("reports every failed read, not only the first, when several reads fail together", async () => {
    getPortalSessionMock.mockResolvedValueOnce({
      user: { id: "u1", email: "creator@creator.test" },
      supabase: supabaseWith({
        profiles: { data: null, error: { message: "profiles down" } },
        review_items: { data: null, error: { message: "items down" } },
      }),
    });
    loadCreatorConsentRowsMock.mockResolvedValueOnce({ rows: [], error: { message: "consents down" } });
    const html = await renderDashboard();
    expect(html).toContain('role="alert"');
    const queries = sentryCaptureMock.mock.calls.map(
      (call) => (call[1] as { tags: { query: string } }).tags.query,
    );
    expect(queries).toEqual(["profiles", "review_items", "consents"]);
  });
});
