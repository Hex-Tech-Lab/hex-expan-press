// Pairwise (PICT) test for billing / consent / checkout parameters changed in 9dfcc5e, e378f18, 0498dfe.
// Model: docs/testing/pairwise/billing_consent_checkout.model.txt
// Rows:  docs/testing/pairwise/billing_consent_checkout.rows.tsv (34 generated PICT rows)
// Expected outcomes are derived independently from the spec, not from route.ts implementation.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { portalConsentState, type PortalConsentRow } from "../../../../../src/lib/consent-chain";

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
  MatrixRouter: { getNextProvider: vi.fn().mockResolvedValue("paddle") },
}));

const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = fileURLToPath(new URL("../../../../../../docs/testing/pairwise/billing_consent_checkout.model.txt", import.meta.url));
const ROWS_PATH = fileURLToPath(new URL("../../../../../../docs/testing/pairwise/billing_consent_checkout.rows.tsv", import.meta.url));

const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const OWNER_ID = "c0a80101-0000-4000-8000-000000000001";
const RELEASE_SHA = "a".repeat(64);
const OLD_SHA = "b".repeat(64);
const LIVE_RAIL_URL = "https://buy.paddle.com/live-rail";
const SANDBOX_RAIL_URL = "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect";

interface PairwiseRow {
  rowNum: number;
  consent_kind: "C1_data_accuracy" | "C2_release_approval" | "C3_revenue_split";
  decision: "given" | "refused" | "forked" | "resolved_by_set";
  provider: "paddle" | "polar" | "creem" | "fungies" | "lemonsqueezy";
  checkout_mode: "live" | "sandbox" | "gated";
  sandbox_flag: "false" | "true";
  vercel_env: "production" | "preview" | "development" | "unset_node_prod" | "unset_node_test";
  product_state:
    | "valid_live_rail"
    | "sandbox_rail_host"
    | "release_hash_mismatch"
    | "no_rails"
    | "bare_slug_ambiguous"
    | "bare_slug_single";
}

function loadRows(tsv: string): PairwiseRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  const expectedCols = ["consent_kind", "decision", "provider", "checkout_mode", "sandbox_flag", "vercel_env", "product_state"];
  if (cols.join(",") !== expectedCols.join(",")) {
    throw new Error(`Unexpected TSV header: ${header}`);
  }
  return lines.map((line, idx) => {
    const [consent_kind, decision, provider, checkout_mode, sandbox_flag, vercel_env, product_state] = line.split("\t");
    return {
      rowNum: idx + 1,
      consent_kind: consent_kind as PairwiseRow["consent_kind"],
      decision: decision as PairwiseRow["decision"],
      provider: provider as PairwiseRow["provider"],
      checkout_mode: checkout_mode as PairwiseRow["checkout_mode"],
      sandbox_flag: sandbox_flag as PairwiseRow["sandbox_flag"],
      vercel_env: vercel_env as PairwiseRow["vercel_env"],
      product_state: product_state as PairwiseRow["product_state"],
    };
  });
}

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = loadRows(ROWS_TSV);

function buildConsentRows(row: PairwiseRow): PortalConsentRow[] {
  const allKinds: PairwiseRow["consent_kind"][] = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];
  const c2Sha = row.product_state === "release_hash_mismatch" ? OLD_SHA : RELEASE_SHA;
  const result: PortalConsentRow[] = [];

  for (const kind of allKinds) {
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
            checkout_url: row.product_state === "sandbox_rail_host" ? SANDBOX_RAIL_URL : LIVE_RAIL_URL,
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
              creator_id: OWNER_ID,
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

/** Independent specification oracle for expected HTTP outcome + redirect target. */
function expectedOutcome(row: PairwiseRow): { status: number; location: string | null; code?: string } {
  if (row.product_state === "bare_slug_ambiguous") {
    return { status: 409, location: null, code: "product_slug_ambiguous" };
  }
  if (row.product_state === "bare_slug_single") {
    return { status: 400, location: null, code: "product_ref_requires_handle" };
  }

  const nonProd = row.vercel_env === "preview" || row.vercel_env === "development" || row.vercel_env === "unset_node_test";
  const sandboxOpen = nonProd && row.sandbox_flag === "true";

  if (row.checkout_mode === "gated") {
    return { status: 403, location: null };
  }
  if (row.checkout_mode === "sandbox" && !sandboxOpen) {
    return { status: 403, location: null };
  }

  if (row.decision === "refused" || row.decision === "forked") {
    return { status: 403, location: null };
  }

  if (row.product_state === "release_hash_mismatch") {
    return { status: 403, location: null };
  }

  if (row.product_state === "no_rails" || row.provider !== "paddle") {
    return { status: 404, location: null };
  }

  if (row.product_state === "sandbox_rail_host" && !sandboxOpen) {
    return { status: 500, location: null };
  }

  return {
    status: 302,
    location: row.product_state === "sandbox_rail_host" ? SANDBOX_RAIL_URL : LIVE_RAIL_URL,
  };
}

/** Independent specification oracle for portalConsentState (Argon F-15 parity). */
function expectedPortalKey(row: PairwiseRow): boolean {
  if (row.decision === "refused" || row.decision === "forked") return false;
  if (row.consent_kind === "C2_release_approval" && row.product_state === "release_hash_mismatch") return false;
  return true;
}

describe("billing / consent / checkout: PICT pairwise artifact integrity", () => {
  it("saved rows file matches live PICT output and covers all 34 rows", () => {
    const liveOut = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(liveOut.trim()).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(34);
  });
});

describe("billing / consent / checkout: 34 PICT pairwise rows", () => {
  beforeEach(() => {
    adminModule.mockAdminClient = null;
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  it.each(ROWS)(
    "row #$rowNum: $consent_kind/$decision | $provider | mode=$checkout_mode | flag=$sandbox_flag | env=$vercel_env | $product_state",
    async (row) => {
      applyRuntimeEnv(row);
      adminModule.mockAdminClient = buildAdminMock(row);

      const productParam =
        row.product_state === "bare_slug_ambiguous"
          ? "shared_slug"
          : row.product_state === "bare_slug_single"
            ? "single_slug"
            : PID;

      const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${productParam}`));
      const want = expectedOutcome(row);

      expect(res.status).toBe(want.status);
      expect(res.headers.get("location")).toBe(want.location);
      if (want.code) {
        expect(await res.json()).toMatchObject({ ok: false, code: want.code });
      }

      // Portal parity check (F-15): portalConsentState must agree with the consent gate for this row's consent_kind.
      const consents = buildConsentRows(row);
      const portal = portalConsentState(consents, PID, RELEASE_SHA);
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

describe("billing / consent / checkout: explicit valid paths missed by 2-way PICT projection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    registryOverride.sandboxCheckoutEnabled = undefined;
  });

  it("resolved_by_set + paddle + live + production + valid_live_rail succeeds with 302", async () => {
    const row: PairwiseRow = {
      rowNum: 101,
      consent_kind: "C2_release_approval",
      decision: "resolved_by_set",
      provider: "paddle",
      checkout_mode: "live",
      sandbox_flag: "false",
      vercel_env: "production",
      product_state: "valid_live_rail",
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${PID}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(LIVE_RAIL_URL);
  });

  it("resolved_by_set + paddle + sandbox + sandbox_flag=true + development + sandbox_rail_host succeeds with 302", async () => {
    const row: PairwiseRow = {
      rowNum: 102,
      consent_kind: "C3_revenue_split",
      decision: "resolved_by_set",
      provider: "paddle",
      checkout_mode: "sandbox",
      sandbox_flag: "true",
      vercel_env: "development",
      product_state: "sandbox_rail_host",
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${PID}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SANDBOX_RAIL_URL);
  });

  it("given + paddle + sandbox + sandbox_flag=false + development + sandbox_rail_host refuses with 403", async () => {
    const row: PairwiseRow = {
      rowNum: 103,
      consent_kind: "C1_data_accuracy",
      decision: "given",
      provider: "paddle",
      checkout_mode: "sandbox",
      sandbox_flag: "false",
      vercel_env: "development",
      product_state: "sandbox_rail_host",
    };
    applyRuntimeEnv(row);
    adminModule.mockAdminClient = buildAdminMock(row);
    const res = await GET(new NextRequest(`http://localhost:3000/api/billing/checkout?product=${PID}`));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });
});
