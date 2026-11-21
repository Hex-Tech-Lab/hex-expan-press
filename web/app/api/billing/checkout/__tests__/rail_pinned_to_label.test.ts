// The rail a buyer is shown (the merchant of record label) must be the rail the route charges. The page sends the rail it labelled
// as `rail`; the route answers 409 rail_changed, with no redirect and no order, when the router would pick a different rail.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { parsePostBody } from "../checkout-helpers";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

const adminModule = vi.hoisted(() => ({
  mockAdminClient: null as unknown,
}));

vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => adminModule.mockAdminClient),
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: sentry.captureException }));

vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("paddle") },
}));

const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OWNER_ID = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);
const PADDLE_URL = "https://buy.paddle.com/live-rail";
const CREEM_URL = "https://buy.creem.io/live-rail-2";

const PRODUCT = { id: PID, creator_id: OWNER_ID, release_sha256: RELEASE_SHA, checkout_mode: "live", price_usd: "39.00" };
const paddleRail = { provider: "paddle", weight: 100, checkout_url: PADDLE_URL, active: true };
const creemRail = { provider: "creem", weight: 50, checkout_url: CREEM_URL, active: true };

function givenConsents() {
  return [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
}

let touched: string[] = [];

function adminClient(rails: Array<Record<string, unknown>>) {
  return {
    from: (table: string) => {
      touched.push(table);
      if (table === "products") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: PRODUCT, error: null }) }) }) };
      }
      if (table === "consents") {
        const consents = givenConsents();
        return {
          select: () => ({ eq: () => ({ in: async () => ({ data: consents, error: null, count: consents.length }) }) }),
        };
      }
      if (table === "product_rails") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: rails, error: null }) }) }) };
      }
      return {};
    },
  };
}

function checkoutRequest(rail?: string): NextRequest {
  const qs = new URLSearchParams({ product: PID });
  if (rail !== undefined) qs.set("rail", rail);
  return new NextRequest(`http://localhost:3000/api/billing/checkout?${qs.toString()}`);
}

beforeEach(() => {
  adminModule.mockAdminClient = null;
  touched = [];
  vi.mocked(MatrixRouter.getNextProvider).mockReset();
  vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
});

describe("checkout route: the charged rail must be the rail the buyer was shown", () => {
  it("two usable rails, router picks paddle, page labelled creem: 409 rail_changed, no redirect, no order", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const res = await GET(checkoutRequest("creem"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "rail_changed" });
    expect(res.headers.get("location")).toBeNull();
    expect(MatrixRouter.getNextProvider).toHaveBeenCalledTimes(1);
    expect(touched).not.toContain("orders");
  });

  it("single usable rail that changed since the page rendered (page labelled creem, only paddle live): 409 rail_changed", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail]);
    const res = await GET(checkoutRequest("creem"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "rail_changed" });
    expect(res.headers.get("location")).toBeNull();
  });

  it("logs a buyer-supplied rail label JSON-encoded and capped: no raw CR/LF, no forged line, bounded length", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const forged = `creem\r\n[billing/checkout] FORGED ${"x".repeat(200)}`;
      const res = await GET(checkoutRequest(forged));
      expect(res.status).toBe(409);
      const mismatchLine = errorSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("rail changed"));
      expect(mismatchLine).toBeDefined();
      // Raw CR/LF from the label never reach the log line.
      expect(mismatchLine).not.toMatch(/[\r\n]/);
      // The label appears JSON-encoded (escaped), and only its first rail_label_log_max_chars characters of the ENCODED text.
      const cap = GLOBAL.payments.rail_label_log_max_chars;
      const shown = JSON.stringify(forged).slice(0, cap);
      expect(mismatchLine).toContain(`page showed ${shown}`);
      expect(mismatchLine).not.toContain("x".repeat(cap + 1));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("caps the JSON-encoded label, so escapes cannot expand the logged value past rail_label_log_max_chars", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 64 NUL characters: 64 characters raw, but each one encodes to a 6-character escape (\u0000).
      const res = await GET(checkoutRequest("\u0000".repeat(64)));
      expect(res.status).toBe(409);
      const mismatchLine = errorSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("rail changed"));
      expect(mismatchLine).toBeDefined();
      const cap = GLOBAL.payments.rail_label_log_max_chars;
      const logged = /page showed (.*), router selected/.exec(mismatchLine ?? "")?.[1] ?? "";
      expect(logged.length).toBeLessThanOrEqual(cap);
      expect(logged.length).toBeGreaterThan(0);
      expect(mismatchLine).not.toMatch(/\u0000/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("configured rails but none usable (switched off): 503, and the outage is reported to Sentry", async () => {
    sentry.captureException.mockClear();
    adminModule.mockAdminClient = adminClient([{ ...paddleRail, active: false }]);
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(503);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("a consent read that throws: 500 and the exception is reported to Sentry", async () => {
    sentry.captureException.mockClear();
    const boom = new Error("consents read failed");
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: PRODUCT, error: null }) }) }) };
        if (table === "consents") return { select: () => ({ eq: () => ({ in: async () => { throw boom; } }) }) };
        return { select: () => ({ eq: () => ({ order: async () => ({ data: paddleRail ? [paddleRail] : [], error: null }) }) }) };
      },
    };
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: expect.objectContaining({ reason: "consent_gate_unexpected" }) }),
    );
  });

  it("an active zero-weight rail is malformed: 500, and the fail-closed 500 is reported to Sentry", async () => {
    sentry.captureException.mockClear();
    adminModule.mockAdminClient = adminClient([{ ...paddleRail, weight: 0 }]);
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("a product_rails query error: 500 and the outage is reported to Sentry", async () => {
    sentry.captureException.mockClear();
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: PRODUCT, error: null }) }) }) };
        if (table === "consents") {
          const consents = givenConsents();
          return { select: () => ({ eq: () => ({ in: async () => ({ data: consents, error: null, count: consents.length }) }) }) };
        }
        return { select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: "rails table down" } }) }) }) };
      },
    };
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("a consents query error: 500 and the outage is reported to Sentry", async () => {
    sentry.captureException.mockClear();
    adminModule.mockAdminClient = {
      from: (table: string) => {
        if (table === "products") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: PRODUCT, error: null }) }) }) };
        if (table === "consents") return { select: () => ({ eq: () => ({ in: async () => ({ data: null, error: { message: "consents table down" }, count: null }) }) }) };
        return { select: () => ({ eq: () => ({ order: async () => ({ data: [paddleRail], error: null }) }) }) };
      },
    };
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("an unexpected MatrixRouter failure: 500 and reported to Sentry, no default provider", async () => {
    sentry.captureException.mockClear();
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router state corrupt"));
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("a missing service-role client: 500 and reported to Sentry (deploy misconfiguration)", async () => {
    sentry.captureException.mockClear();
    adminModule.mockAdminClient = null;
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("zero configured rail rows is a designed state: 503 with no Sentry report", async () => {
    sentry.captureException.mockClear();
    adminModule.mockAdminClient = adminClient([]);
    const res = await GET(checkoutRequest());
    expect(res.status).toBe(503);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("control: page labelled paddle and router picks paddle: redirect to the paddle rail", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const res = await GET(checkoutRequest("paddle"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PADDLE_URL);
  });

  it("control: no label sent (multi-rail page shows no merchant of record): unchanged behaviour, router's pick is used", async () => {
    adminModule.mockAdminClient = adminClient([paddleRail, creemRail]);
    const res = await GET(checkoutRequest());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PADDLE_URL);
  });
});

describe("parsePostBody: the labelled rail is read from the POST body", () => {
  const postUrl = `http://localhost:3000/api/billing/checkout`;

  it("reads rail from a JSON body", async () => {
    const req = new NextRequest(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: PID, rail: "creem" }),
    });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.expectedRail).toBe("creem");
  });

  it("reads rail from a form-encoded body", async () => {
    const req = new NextRequest(postUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `product=${PID}&rail=paddle`,
    });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.expectedRail).toBe("paddle");
  });

  it.each([
    ["a number", 42],
    ["a boolean", true],
    ["an array", ["creem"]],
    ["an object", { provider: "creem" }],
  ])("refuses a rail that is %s with 400 rail_invalid, not a silent null", async (_label, rail) => {
    const req = new NextRequest(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: PID, rail }),
    });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.status).toBe(400);
      expect(await parsed.response.json()).toMatchObject({ ok: false, code: "rail_invalid" });
    }
  });

  it("refuses a multipart file part as rail with 400 rail_invalid, not a silent null", async () => {
    // A urlencoded body is always strings, so the only non-string rail that reaches the form branch is a multipart File part.
    const form = new FormData();
    form.append("product", PID);
    form.append("rail", new File(["paddle"], "rail.txt", { type: "text/plain" }));
    const req = new NextRequest(postUrl, { method: "POST", body: form });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.response.status).toBe(400);
      expect(await parsed.response.json()).toMatchObject({ ok: false, code: "rail_invalid" });
    }
  });

  it("is null when no rail is sent", async () => {
    const req = new NextRequest(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: PID }),
    });
    const parsed = await parsePostBody(req);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.expectedRail).toBeNull();
  });
});
