// Pairwise (PICT) test for product price and payment rail on /api/billing/checkout (KYC P1, unpriced-no-buy).
// Model: docs/testing/pairwise/unpriced_checkout.model.txt
// Rows:  docs/testing/pairwise/unpriced_checkout.rows.tsv (every generated row is asserted below)
// Expected outcomes come from expectedOutcome() below, written from the specification, not from route.ts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { MatrixRouter } from "../../../../../../src/infrastructure/matrix_router/matrix_router";
import { MatrixRouterUnavailableError } from "../../../../../../src/infrastructure/matrix_router/matrix_router_errors";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";

const adminModule = vi.hoisted(() => ({
  mockAdminClient: null as unknown,
}));

vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => adminModule.mockAdminClient),
}));

vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("paddle") },
}));

const MODEL_PATH = fileURLToPath(new URL("../../../../../../docs/testing/pairwise/unpriced_checkout.model.txt", import.meta.url));
const ROWS_PATH = fileURLToPath(new URL("../../../../../../docs/testing/pairwise/unpriced_checkout.rows.tsv", import.meta.url));
const PICT_BIN = "/usr/local/bin/pict";
const EXPECTED_ROW_COUNT = 8;
const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");

const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OWNER_ID = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);
const RAIL_URL = "https://buy.paddle.com/live-rail";

type Row = { price: "set" | "null"; rail: "present" | "absent" | "router_error" | "breaker"; checkout_mode: "live" | "gated" };

interface Expected {
  status: number;
  code?: string;
  retryAfter?: "no_active_rail" | "router_error";
  // 500 rows carry no Retry-After; the code is the only contract on that path.
  location: boolean;
  tables: string[];
  routerCalled: boolean;
}

// Spec: the mode gate runs first (gated is refused), then the price gate (null is 409), then rails (none active is 503 + Retry-After),
// then the router: only the known breaker outage is 503 + Retry-After; any other router error is 500 router_unexpected_error
// with no Retry-After, and never a default-rail fallback. Only a priced live product on a routed rail is redirected (302).
// Tables are the reads the route makes before it answers.
function expectedOutcome(row: Row): Expected {
  const reads = ["products", "consents", "product_rails"];
  if (row.checkout_mode === "gated") return { status: 403, location: false, tables: ["products"], routerCalled: false };
  if (row.price === "null") return { status: 409, code: "product_unpriced", location: false, tables: ["products"], routerCalled: false };
  if (row.rail === "absent") {
    return { status: 503, code: "no_active_rail", retryAfter: "no_active_rail", location: false, tables: reads, routerCalled: false };
  }
  if (row.rail === "router_error") {
    return { status: 500, code: "router_unexpected_error", location: false, tables: reads, routerCalled: true };
  }
  // The breaker (every rail marked down) is the known outage: 503 with the router Retry-After.
  if (row.rail === "breaker") {
    return { status: 503, code: "rails_unavailable", retryAfter: "router_error", location: false, tables: reads, routerCalled: true };
  }
  return { status: 302, location: true, tables: reads, routerCalled: true };
}

function parseRows(tsv: string): Row[] {
  const [header, ...lines] = tsv.trim().split("\n");
  const cols = header!.split("\t");
  return lines.map((line) => {
    const fields = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, i) => [c, fields[i]]));
    return rec as unknown as Row;
  });
}

const ROWS = parseRows(ROWS_TSV);

function givenConsents() {
  return [
    { id: "c1", kind: "C1_data_accuracy", decision: "given", product_id: PID, supersedes: null },
    { id: "c2", kind: "C2_release_approval", decision: "given", product_id: PID, supersedes: null, document_sha256: RELEASE_SHA },
    { id: "c3", kind: "C3_revenue_split", decision: "given", product_id: PID, supersedes: null },
  ];
}

let touched: string[] = [];

function clientFor(row: Row) {
  const product = {
    id: PID,
    creator_id: OWNER_ID,
    release_sha256: RELEASE_SHA,
    checkout_mode: row.checkout_mode,
    price_usd: row.price === "set" ? "39.00" : null,
  };
  const rails = row.rail === "absent" ? [] : [{ provider: "paddle", weight: 100, checkout_url: RAIL_URL, active: true }];
  if (row.rail === "router_error") vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new Error("router down"));
  if (row.rail === "breaker") vi.mocked(MatrixRouter.getNextProvider).mockRejectedValueOnce(new MatrixRouterUnavailableError("payments", PID));
  return {
    from: (table: string) => {
      touched.push(table);
      if (table === "products") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: product, error: null }) }) }) };
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

beforeEach(() => {
  adminModule.mockAdminClient = null;
  touched = [];
  vi.mocked(MatrixRouter.getNextProvider).mockReset();
  vi.mocked(MatrixRouter.getNextProvider).mockResolvedValue("paddle");
});

describe("billing / checkout: PICT pairwise artifact integrity (unpriced_checkout)", () => {
  it("saved rows file matches live PICT output and has the expected row count", () => {
    const liveOut = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(liveOut.trim()).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });
});

describe(`billing / checkout: ${EXPECTED_ROW_COUNT} PICT pairwise rows (price x rail x checkout_mode)`, () => {
  it.each(ROWS.map((row, i) => [i + 1, row] as const))("row #%i: price=%s rail=%s checkout_mode=%s", async (_i, row) => {
    adminModule.mockAdminClient = clientFor(row);
    const want = expectedOutcome(row);
    const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${PID}`));
    expect(res.status).toBe(want.status);
    if (want.code) expect(await res.json()).toMatchObject({ code: want.code });
    if (want.retryAfter === "no_active_rail") expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_no_rail_retry_after_seconds));
    if (want.retryAfter === "router_error") expect(res.headers.get("retry-after")).toBe(String(GLOBAL.payments.checkout_router_error_retry_after_seconds));
    if (!want.retryAfter && want.status >= 500) expect(res.headers.get("retry-after")).toBeNull();
    // A redirect must go to the configured rail exactly; every other outcome must have no Location.
    if (want.location) expect(res.headers.get("location")).toBe(RAIL_URL);
    else expect(res.headers.get("location")).toBeNull();
    expect(touched).toEqual(want.tables);
    expect(vi.mocked(MatrixRouter.getNextProvider).mock.calls.length > 0).toBe(want.routerCalled);
  });
});
