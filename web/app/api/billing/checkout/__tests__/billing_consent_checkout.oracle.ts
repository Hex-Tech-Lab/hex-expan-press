// Pure oracle for the billing / consent / checkout pairwise rows (docs/testing/pairwise/billing_consent_checkout.model.txt).
// Expected outcomes are written from the specification and the route's order of checks. This module imports nothing from the
// route or the settings registry, so it cannot inherit an implementation bug. Shared by the pairwise test and the coverage report.

export const CONSENT_KINDS = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"] as const;

export const MODEL_COLUMNS = [
  "consent_kind",
  "decision",
  "provider",
  "provider_path",
  "checkout_mode",
  "sandbox_flag",
  "vercel_env",
  "product_state",
  "rail_mode",
  "buyer_email",
  "buyer_consent",
  "buyer_country",
  "creator_kind",
] as const;

/** Allowed values per column. A row with a value outside its column's set fails the parse, so a typo cannot pass silently. */
export const COLUMN_VALUES = {
  consent_kind: CONSENT_KINDS,
  decision: ["given", "refused", "forked", "resolved_by_set"],
  provider: ["paddle", "polar", "creem", "fungies", "lemonsqueezy"],
  provider_path: ["overlay", "redirect"],
  checkout_mode: ["live", "sandbox", "gated"],
  sandbox_flag: ["false", "true"],
  vercel_env: ["production", "preview", "development", "unset_node_prod", "unset_node_test"],
  product_state: ["active_rail", "no_rails", "release_hash_mismatch", "bare_slug_ambiguous", "bare_slug_single"],
  rail_mode: ["live", "sandbox"],
  buyer_email: ["absent", "valid", "invalid", "typo_suggested"],
  buyer_consent: ["checked", "unchecked"],
  buyer_country: ["us", "us_territory", "non_us"],
  creator_kind: ["creator", "house"],
} as const satisfies Record<(typeof MODEL_COLUMNS)[number], readonly string[]>;

export type RowValues = { [K in (typeof MODEL_COLUMNS)[number]]: (typeof COLUMN_VALUES)[K][number] };
export interface PairwiseRow extends RowValues {
  rowNum: number;
}

export const PID = "57596c19-c550-4bde-b17a-e87b86d005c5";
export const RELEASE_SHA = "a".repeat(64);
export const OLD_SHA = "b".repeat(64);
export const LIVE_RAIL_URL = "https://buy.paddle.com/live-rail";
export const SANDBOX_RAIL_URL = "https://sandbox-api.polar.sh/v1/checkout-links/x/redirect";

/** Parses the PICT TSV. The header must match the model columns exactly, and every value must be in its column's set. */
export function parseRows(tsv: string): PairwiseRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  if (cols.join(",") !== MODEL_COLUMNS.join(",")) {
    throw new Error(`Unexpected TSV header: ${header}`);
  }
  return lines.map((line, idx) => {
    const fields = line.split("\t");
    if (fields.length !== MODEL_COLUMNS.length) {
      throw new Error(`Row ${idx + 1} has ${fields.length} fields, expected ${MODEL_COLUMNS.length}`);
    }
    const values: Record<string, string> = {};
    MODEL_COLUMNS.forEach((column, i) => {
      const allowed: readonly string[] = COLUMN_VALUES[column];
      if (!allowed.includes(fields[i])) {
        throw new Error(`Row ${idx + 1}: ${column}=${fields[i]} is not in the model`);
      }
      values[column] = fields[i];
    });
    return { rowNum: idx + 1, ...(values as RowValues) };
  });
}

export interface Outcome {
  status: number;
  /** Routed checkout delivery kind when status is 200 or 302. */
  kind?: "paddle_overlay" | "redirect";
  /** Set on 302: the rail URL the route must redirect to (the provider may append parameters). */
  railUrl?: string;
  /** Set where the body's machine code is part of the contract. */
  code?: string;
}

/** True when the request runs where sandbox checkout may open: a preview or development deploy, or no VERCEL_ENV outside production. */
function sandboxOpen(row: PairwiseRow): boolean {
  const nonProd = row.vercel_env === "preview" || row.vercel_env === "development" || row.vercel_env === "unset_node_test";
  return nonProd && row.sandbox_flag === "true";
}

/** Expected HTTP outcome for one row, in the order the checkout route evaluates its gates. */
export function expectedOutcome(row: PairwiseRow): Outcome {
  // 1. Geo gate: the US, its territories, and DC only. It runs before any other check.
  if (row.buyer_country === "non_us") return { status: 403, code: "country_not_supported" };

  // 2. Buyer email shape: a malformed address is a 400 before the product is looked up. Overlay POST also requires an email.
  if (row.buyer_email === "invalid" || (row.provider_path === "overlay" && row.buyer_email === "absent")) {
    return { status: 400, code: "buyer_email_invalid" };
  }

  // 3. Product reference: a bare slug is ambiguous (409) or needs its creator handle (400).
  if (row.product_state === "bare_slug_ambiguous") return { status: 409, code: "product_slug_ambiguous" };
  if (row.product_state === "bare_slug_single") return { status: 400, code: "product_ref_requires_handle" };

  // 4. Launch state: gated products never open checkout; sandbox products only where sandbox checkout may open.
  if (row.checkout_mode === "gated") return { status: 403 };
  if (row.checkout_mode === "sandbox" && !sandboxOpen(row)) return { status: 403 };

  // 5. Consents: a refused or forked head of the kind under evaluation blocks an external creator's checkout.
  //    A house title has no creator consents, so its decision never blocks it (house-title exemption, 2026-11-19).
  if (row.creator_kind === "creator" && (row.decision === "refused" || row.decision === "forked")) return { status: 403 };

  // 6. Release hash: the creator's approved C2 document, or for a house title its pinned digest, must match the release hash.
  if (row.product_state === "release_hash_mismatch") return { status: 403 };

  // 7. Rails: none configured, or none routable (switched-off or unverified provider).
  if (row.product_state === "no_rails") return { status: 404 };
  if (row.provider !== "paddle" && row.provider !== "creem") return { status: 404 };

  // 8. Rail host class must match the product's mode. A sandbox host is refused unless sandbox checkout may open.
  const railSandbox = row.rail_mode === "sandbox";
  if (railSandbox !== (row.checkout_mode === "sandbox")) return { status: 500 };
  if (railSandbox && !sandboxOpen(row)) return { status: 500 };

  // 9. Routed: Paddle overlay returns 200 JSON payload; redirect path returns 302 to the matching rail URL.
  if (row.provider_path === "overlay") return { status: 200, kind: "paddle_overlay" };
  return { status: 302, kind: "redirect", railUrl: railSandbox ? SANDBOX_RAIL_URL : LIVE_RAIL_URL };
}

/** Expected portalConsentState flag (Argon F-15 parity) for the row's consent kind. */
export function expectedPortalKey(row: PairwiseRow): boolean {
  if (row.decision === "refused" || row.decision === "forked") return false;
  if (row.consent_kind === "C2_release_approval" && row.product_state === "release_hash_mismatch") return false;
  return true;
}
