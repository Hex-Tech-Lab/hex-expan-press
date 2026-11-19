// Pairwise (PICT) test for billing / consent / checkout parameters of GET /api/billing/checkout.
// Model: docs/testing/pairwise/billing_consent_checkout.model.txt
// Rows:  docs/testing/pairwise/billing_consent_checkout.rows.tsv (42 generated PICT rows, every row asserted below)
// Expected outcomes come from billing_consent_checkout.oracle.ts, written from the specification, not from route.ts.
// Test world only: creem is routable here through an override of isEnabledPaymentProvider. Production settings keep creem off.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { portalConsentState, type PortalConsentRow } from "../../../../../src/lib/consent-chain";
import { GLOBAL } from "../../../../../../payments/src/settings_registry";
import {
  CONSENT_KINDS,
  LIVE_RAIL_URL,
  OLD_SHA,
  PID,
  RELEASE_SHA,
  SANDBOX_RAIL_URL,
  expectedOutcome,
  expectedPortalKey,
  parseRows,
  type PairwiseRow,
} from "./billing_consent_checkout.oracle";

const adminModule = vi.hoisted(() => ({
  mockAdminClient: null as unknown,
}));

const registryOverride = vi.hoisted(() => ({
  sandboxCheckoutEnabled: undefined as boolean | undefined,
}));

vi.mock("../../../../../../payments/src/settings_registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../payments/src/settings_registry")>();
  return {
    ...actual,
    // Test world only: creem is routable so its rows reach the rail. Production settings keep creem switched off.
    isEnabledPaymentProvider: (name: string) => name === "creem" || actual.isEnabledPaymentProvider(name),
    GLOBAL: new Proxy(actual.GLOBAL, {
      get(target, prop, receiver) {
        if (prop === "payments" && registryOverride.sandboxCheckoutEnabled !== undefined) {
          return {
            ...target.payments,
            sandbox_checkout_enabled: registryOverride.sandboxCheckoutEnabled,
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

vi.mock("../../../../../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => adminModule.mockAdminClient),
}));

vi.mock("../../../../../../src/infrastructure/matrix_router/matrix_router", () => ({
  // Selects the first rail offered, so the routed provider is the row's provider.
  MatrixRouter: {
    getNextProvider: vi.fn(async (_scope: string, _productId: string, rails: Array<{ provider: string }>) => rails[0]?.provider),
  },
}));

const MODEL_PATH = fileURLToPath(new URL("../../../../../../docs/testing/pairwise/billing_consent_checkout.model.txt", import.meta.url));
const ROWS_PATH = fileURLToPath(new URL("../../../../../../docs/testing/pairwise/billing_consent_checkout.rows.tsv", import.meta.url));
const PICT_BIN = "/usr/local/bin/pict";
const EXPECTED_ROW_COUNT = 42;

const BUYER_EMAIL: Partial<Record<PairwiseRow["buyer_email"], string>> = {
  valid: "buyer@example.com",
  invalid: "not-an-email",
  typo_suggested: "buyer@gmial.com", // valid shape with a likely domain typo: the server accepts it unchanged
};
const COUNTRY_HEADER: Record<PairwiseRow["buyer_country"], string> = {
  us: "US",
  us_territory: "PR",
  non_us: "DE",
};

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);

function buildConsentRows(row: PairwiseRow): PortalConsentRow[] {
  const c2Sha = row.product_state === "release_hash_mismatch" ? OLD_SHA : RELEASE_SHA;
  const result: PortalConsentRow[] = [];

  for (const kind of CONSENT_KINDS) {
    const docSha = kind === "C2_release_approval" ? c2Sha : null;
    if (kind !== row.consent_kind) {
      result.push({
        id: `${kind}_base`,
        kind,
        decision: "given",
        product_id: PID,
        supersedes: null,
        supersedes_ids: [],
        document_sha256: docSha,
      });
      continue;
    }

    if (row.decision === "given" || row.decision === "refused") {
      result.push({
        id: `${kind}_single`,
        kind,
        decision: row.decision,
        product_id: PID,
        supersedes: null,
        supersedes_ids: [],
        document_sha256: docSha,
      });
    } else if (row.decision === "forked") {
      result.push(
        { id: `${kind}_fork_a`, kind, decision: "given", product_id: PID, supersedes: null, supersedes_ids: [], document_sha256: docSha },
        { id: `${kind}_fork_b`, kind, decision: "refused", product_id: PID, supersedes: null, supersedes_ids: [], document_sha256: docSha },
      );
    } else {
      // resolved_by_set: two forked heads retired by a single successor via supersedes_ids (migration 20261116142329)
      result.push(
        { id: `${kind}_fork_a`, kind, decision: "given", product_id: PID, supersedes: null, supersedes_ids: [], document_sha256: docSha },
        { id: `${kind}_fork_b`, kind, decision: "refused", product_id: PID, supersedes: null, supersedes_ids: [], document_sha256: docSha },
        {
          id: `${kind}_set_head`,
          kind,
          decision: "given",
          product_id: PID,
          supersedes: `${kind}_fork_b`,
          supersedes_ids: [`${kind}_fork_a`, `${kind}_fork_b`],
          document_sha256: docSha,
        },
      );
    }
  }
  return result;
}

function buildAdminMock(row: PairwiseRow) {
  const consents = buildConsentRows(row);
  const rails =
    row.product_state === "no_rails"
      ? []
      : [
          {
            provider: row.provider,
            weight: 100,
            checkout_url: row.rail_mode === "sandbox" ? SANDBOX_RAIL_URL : LIVE_RAIL_URL,
            active: true,
          },
        ];

  return {
    from: (table: string) => {
      if (table === "products") {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({
            data: {
              id: PID,
              creator_id: "c0a80101-0000-4000-8000-000000000001",
              release_sha256: RELEASE_SHA,
              checkout_mode: row.checkout_mode,
            },
            error: null,
          }),
          limit: async () => {
            if (row.product_state === "bare_slug_ambiguous") {
              return { data: [{ id: "p-1" }, { id: "p-2" }], error: null };
            }
            if (row.product_state === "bare_slug_single") {
              return { data: [{ id: PID }], error: null };
            }
            return { data: [], error: null };
          },
        };
        return { select: () => chain };
      }
      if (table === "consents") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: consents,
                error: null,
                count: consents.length,
              }),
            }),
          }),
        };
      }
      if (table === "product_rails") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: rails, error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

function applyRuntimeEnv(row: PairwiseRow): void {
  if (row.vercel_env === "unset_node_prod") {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "production");
  } else if (row.vercel_env === "unset_node_test") {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("NODE_ENV", "test");
  } else {
    vi.stubEnv("VERCEL_ENV", row.vercel_env);
  }
  registryOverride.sandboxCheckoutEnabled = row.sandbox_flag === "true";
}

function checkoutRequest(row: PairwiseRow, productParam: string): NextRequest {
  const params = new URLSearchParams({
    product: productParam,
    buyer_consent: row.buyer_consent === "checked" ? "true" : "false",
  });
  const email = BUYER_EMAIL[row.buyer_email];
  if (email !== undefined) params.set("buyer_email", email);
  return new NextRequest(`http://localhost:3000/api/billing/checkout?${params.toString()}`, {
    headers: { "x-vercel-ip-country": COUNTRY_HEADER[row.buyer_country] },
  });
}

/** A 302 must land on the rail. Paddle documents no link parameters, so its URL is exact. Creem carries the product and the consent. */
function assertRedirect(location: string | null, row: PairwiseRow, railUrl: string | undefined): void {
  expect(location).not.toBeNull();
  const target = new URL(location as string);
  const rail = new URL(railUrl as string);
  expect(`${target.origin}${target.pathname}`).toBe(`${rail.origin}${rail.pathname}`);
  if (row.provider === "paddle") {
    expect(location).toBe(railUrl);
  } else {
    expect(target.searchParams.get("metadata[product_id]")).toBe(PID);
    expect(target.searchParams.get(`metadata[${GLOBAL.delivery.buyer_consent_metadata_key}]`)).toBe(
      row.buyer_consent === "checked" ? "true" : "false",
    );
  }
}

describe("billing / consent / checkout: PICT pairwise artifact integrity", () => {
  it("saved rows file matches live PICT output and covers all generated rows", () => {
    const liveOut = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(liveOut.trim()).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });
});

describe(`billing / consent / checkout: ${EXPECTED_ROW_COUNT} PICT pairwise rows`, () => {
  beforeEach(() => {
    adminModule.mockAdminClient = null;
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  it.each(ROWS)(
    "row #$rowNum: $consent_kind/$decision | $provider | mode=$checkout_mode | flag=$sandbox_flag | env=$vercel_env | $product_state | rail=$rail_mode | email=$buyer_email | consent=$buyer_consent | country=$buyer_country",
    async (row) => {
      applyRuntimeEnv(row);
      adminModule.mockAdminClient = buildAdminMock(row);

      const productParam =
        row.product_state === "bare_slug_ambiguous"
          ? "shared_slug"
          : row.product_state === "bare_slug_single"
            ? "single_slug"
            : PID;

      const res = await GET(checkoutRequest(row, productParam));
      const want = expectedOutcome(row);

      expect(res.status).toBe(want.status);
      if (want.code) {
        expect(await res.json()).toMatchObject({ ok: false, code: want.code });
      }
      if (want.status === 302) {
        assertRedirect(res.headers.get("location"), row, want.railUrl);
      } else {
        expect(res.headers.get("location")).toBeNull();
      }

      // Portal parity check (F-15): portalConsentState must agree with the consent gate for this row's consent_kind.
      const portal = portalConsentState(buildConsentRows(row), PID, RELEASE_SHA);
      const portalFlag =
        row.consent_kind === "C1_data_accuracy"
          ? portal.hasC1
          : row.consent_kind === "C2_release_approval"
            ? portal.hasC2
            : portal.hasC3;
      expect(portalFlag).toBe(expectedPortalKey(row));
    },
  );
});

describe("billing / consent / checkout: explicit valid paths", () => {
  const US_BUYER = { buyer_email: "absent", buyer_consent: "unchecked", buyer_country: "us" } as const;

  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  it("resolved_by_set + paddle + live + production + active live rail succeeds with 302", async () => {
    const row: PairwiseRow = {
      rowNum: 101,
      consent_kind: "C2_release_approval",
      decision: "resolved_by_set",
      provider: "paddle",
      checkout_mode: "live",
      sandbox_flag: "false",
      vercel_env: "production",
      product_state: "active_rail",
      rail_mode: "live",
      ...US_BUYER,
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(checkoutRequest(row, PID));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(LIVE_RAIL_URL);
  });

  it("resolved_by_set + paddle + sandbox + sandbox_flag=true + development + sandbox rail succeeds with 302", async () => {
    const row: PairwiseRow = {
      rowNum: 102,
      consent_kind: "C3_revenue_split",
      decision: "resolved_by_set",
      provider: "paddle",
      checkout_mode: "sandbox",
      sandbox_flag: "true",
      vercel_env: "development",
      product_state: "active_rail",
      rail_mode: "sandbox",
      ...US_BUYER,
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(checkoutRequest(row, PID));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SANDBOX_RAIL_URL);
  });

  it("given + paddle + sandbox + sandbox_flag=false + development + sandbox rail refuses with 403", async () => {
    const row: PairwiseRow = {
      rowNum: 103,
      consent_kind: "C1_data_accuracy",
      decision: "given",
      provider: "paddle",
      checkout_mode: "sandbox",
      sandbox_flag: "false",
      vercel_env: "development",
      product_state: "active_rail",
      rail_mode: "sandbox",
      ...US_BUYER,
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(checkoutRequest(row, PID));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  // The pairwise rows cover every pair of factors, but masking gates (refused heads, gated launch) hide the rail-mode mismatch
  // outcome in every generated row. These three cases make it, and the creem metadata path, observable.
  it("live product with a sandbox rail host is refused as 500 even with the sandbox flag on (rail mode mismatch)", async () => {
    const row: PairwiseRow = {
      rowNum: 104,
      consent_kind: "C2_release_approval",
      decision: "given",
      provider: "paddle",
      checkout_mode: "live",
      sandbox_flag: "true",
      vercel_env: "preview",
      product_state: "active_rail",
      rail_mode: "sandbox",
      ...US_BUYER,
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(checkoutRequest(row, PID));
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("sandbox product with a live rail host is refused as 500 when sandbox checkout is open (rail mode mismatch)", async () => {
    const row: PairwiseRow = {
      rowNum: 105,
      consent_kind: "C1_data_accuracy",
      decision: "given",
      provider: "paddle",
      checkout_mode: "sandbox",
      sandbox_flag: "true",
      vercel_env: "development",
      product_state: "active_rail",
      rail_mode: "live",
      ...US_BUYER,
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(checkoutRequest(row, PID));
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("creem rail on a live product redirects with the buyer's consent carried as creem metadata", async () => {
    const row: PairwiseRow = {
      rowNum: 106,
      consent_kind: "C3_revenue_split",
      decision: "given",
      provider: "creem",
      checkout_mode: "live",
      sandbox_flag: "false",
      vercel_env: "production",
      product_state: "active_rail",
      rail_mode: "live",
      buyer_email: "valid",
      buyer_consent: "checked",
      buyer_country: "us",
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(checkoutRequest(row, PID));
    expect(res.status).toBe(302);
    assertRedirect(res.headers.get("location"), row, LIVE_RAIL_URL);
  });
});
