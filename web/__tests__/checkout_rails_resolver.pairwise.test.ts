// Pairwise (PICT) test for the shared rail resolver and the rail-aware buyer view (KYC P1, mor-label-shared-resolver).
// Model: docs/testing/pairwise/checkout_rails_resolver.model.txt
// Rows:  docs/testing/pairwise/checkout_rails_resolver.rows.tsv (every generated row is asserted below)
// Expected outcomes come from expectedOutcome() below, written from the specification, not from the implementation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkoutRailView, resolveCheckoutRails, usableRailsOf } from "../src/lib/checkout-rails";

const ROWS_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/checkout_rails_resolver.rows.tsv", import.meta.url));
const EXPECTED_ROW_COUNT = 12;
const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");

type Row = {
  rails: "zero" | "one" | "two";
  provider: "paddle" | "creem";
  price: "set" | "null";
  checkout_mode: "live" | "gated" | "sandbox" | "paddle";
};

// Every provider in the model is enabled and verified, so the rail count is decided by the rows, not by the policy.
const POLICY = {
  isEnabledProvider: () => true,
  verifiedProviders: new Set(["paddle", "creem"]),
  checkoutMode: "live",
  checkoutUrlProblem: () => null,
};

function railRowsFor(row: Row) {
  const url = (p: string) => `https://buy.example/${p}-rail`;
  if (row.rails === "zero") return [];
  if (row.rails === "one") return [{ provider: row.provider, weight: 100, checkout_url: url(row.provider), active: true }];
  return [
    { provider: "paddle", weight: 100, checkout_url: url("paddle"), active: true },
    { provider: "creem", weight: 50, checkout_url: url("creem"), active: true },
  ];
}

// Spec: buy form only for live, priced, with at least one usable rail. Merchant of record named only for exactly one usable rail.
// Only checkout_mode "live" is sold on the buy form; gated, sandbox and paddle modes never are.
function expectedOutcome(row: Row): { purchasable: boolean; merchantOfRecordProvider: string | null } {
  const purchasable = row.checkout_mode === "live" && row.price === "set" && row.rails !== "zero";
  return { purchasable, merchantOfRecordProvider: purchasable && row.rails === "one" ? row.provider : null };
}

function parseRows(tsv: string): Row[] {
  const [header, ...lines] = tsv.trim().split("\n");
  const cols = header!.split("\t");
  return lines.map((line) => {
    const fields = line.split("\t");
    return Object.fromEntries(cols.map((c, i) => [c, fields[i]])) as unknown as Row;
  });
}

const ROWS = parseRows(ROWS_TSV);

describe("checkout rails pairwise (PICT model)", () => {
  it("has the generated row count and covers every rail count", () => {
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
    expect(new Set(ROWS.map((r) => r.rails))).toEqual(new Set(["zero", "one", "two"]));
  });

  it("covers every checkout_mode the DB constraint allows", () => {
    expect(new Set(ROWS.map((r) => r.checkout_mode))).toEqual(new Set(["live", "gated", "sandbox", "paddle"]));
  });

  it("pins the one-rail Creem live row (merchant of record is Creem, not Paddle)", () => {
    const creemRow = ROWS.find((r) => r.rails === "one" && r.provider === "creem" && r.price === "set" && r.checkout_mode === "live");
    if (creemRow === undefined) throw new Error("the one-rail Creem live row is missing from the generated PICT rows");
    const view = checkoutRailView({ checkout_mode: "live", price_usd: "39.00" }, usableRailsOf(resolveCheckoutRails(railRowsFor(creemRow), POLICY)));
    expect(view).toEqual({ purchasable: true, merchantOfRecordProvider: "creem" });
  });

  for (const row of ROWS) {
    const label = `rails=${row.rails} provider=${row.provider} price=${row.price} checkout_mode=${row.checkout_mode}`;
    it(`${label}: shared resolver and buyer view match the specification`, () => {
      const resolved = resolveCheckoutRails(railRowsFor(row), POLICY);
      expect(resolved.kind).toBe("ok");
      const view = checkoutRailView(
        { checkout_mode: row.checkout_mode, price_usd: row.price === "set" ? "39.00" : null },
        usableRailsOf(resolved),
      );
      expect(view).toEqual(expectedOutcome(row));
    });
  }
});
