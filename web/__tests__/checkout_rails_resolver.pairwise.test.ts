// Pairwise (PICT) test for the shared rail resolver and the rail-aware buyer view (KYC P1, mor-label-shared-resolver).
// Model: docs/testing/pairwise/checkout_rails_resolver.model.txt
// Seed:  docs/testing/pairwise/checkout_rails_resolver.seed.tsv (pins the one-rail Creem live row)
// Rows:  docs/testing/pairwise/checkout_rails_resolver.rows.tsv (every generated row is asserted below)
// Expected outcomes come from expectedOutcome() below, written from the specification, not from the implementation.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkoutRailView, resolveCheckoutRails, usableRailsOf } from "../src/lib/checkout-rails";

const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/checkout_rails_resolver.model.txt", import.meta.url));
const SEED_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/checkout_rails_resolver.seed.tsv", import.meta.url));
const ROWS_PATH = fileURLToPath(new URL("../../docs/testing/pairwise/checkout_rails_resolver.rows.tsv", import.meta.url));
const EXPECTED_ROW_COUNT = 15;
const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");

type Row = {
  rails: "zero" | "one" | "two";
  provider: "paddle" | "creem";
  price: "set" | "null";
  checkout_mode: "live" | "gated" | "sandbox" | "paddle" | "null";
  sandboxAllowed: "true" | "false";
};

// PICT writes the NULL value as the token "null"; the product column is nullable, so it maps to a real null.
function modeOf(row: Row): string | null {
  return row.checkout_mode === "null" ? null : row.checkout_mode;
}

// Every provider in the model is enabled and verified, so the rail count is decided by the rows, not by the policy.
const POLICY = {
  isEnabledProvider: () => true,
  verifiedProviders: new Set(["paddle", "creem"]),
  checkoutMode: "live" as string | null,
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

// Spec: buy form for launch-open (live, or sandbox when sandboxAllowed is true), priced, with at least one usable rail.
// Merchant of record named only for exactly one usable rail.
function expectedOutcome(row: Row): { purchasable: boolean; merchantOfRecordProvider: string | null } {
  const launchOpen =
    row.checkout_mode === "live" || (row.checkout_mode === "sandbox" && row.sandboxAllowed === "true");
  const purchasable = launchOpen && row.price === "set" && row.rails !== "zero";
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
  it("checked-in rows TSV matches /usr/local/bin/pict output (no model drift)", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const generated = execFileSync(PICT_BIN, [MODEL_PATH, `/e:${SEED_PATH}`], { encoding: "utf8" }).trim();
    expect(generated).toBe(ROWS_TSV.trim());
  });

  it("has the generated row count and covers every rail count and sandboxAllowed value", () => {
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
    expect(new Set(ROWS.map((r) => r.rails))).toEqual(new Set(["zero", "one", "two"]));
    expect(new Set(ROWS.map((r) => r.sandboxAllowed))).toEqual(new Set(["true", "false"]));
  });

  it("covers every checkout_mode the DB allows, including the nullable NULL", () => {
    expect(new Set(ROWS.map((r) => r.checkout_mode))).toEqual(new Set(["live", "gated", "sandbox", "paddle", "null"]));
  });

  it("pins the one-rail Creem live row (merchant of record is Creem, not Paddle)", () => {
    const creemRow = ROWS.find((r) => r.rails === "one" && r.provider === "creem" && r.price === "set" && r.checkout_mode === "live");
    if (creemRow === undefined) throw new Error("the one-rail Creem live row is missing from the generated PICT rows");
    const view = checkoutRailView(
      { checkout_mode: "live", price_usd: "39.00" },
      usableRailsOf(resolveCheckoutRails(railRowsFor(creemRow), POLICY)),
      creemRow.sandboxAllowed === "true",
    );
    expect(view).toEqual({ purchasable: true, merchantOfRecordProvider: "creem" });
  });

  it("covers sandbox purchasable only when sandboxAllowed is true", () => {
    const allowedSandbox = ROWS.find(
      (r) => r.checkout_mode === "sandbox" && r.sandboxAllowed === "true" && r.price === "set" && r.rails !== "zero",
    );
    const blockedSandbox = ROWS.find(
      (r) => r.checkout_mode === "sandbox" && r.sandboxAllowed === "false" && r.price === "set" && r.rails !== "zero",
    );
    expect(allowedSandbox).toBeDefined();
    expect(blockedSandbox).toBeDefined();
    expect(expectedOutcome(allowedSandbox!).purchasable).toBe(true);
    expect(expectedOutcome(blockedSandbox!).purchasable).toBe(false);
  });

  for (const row of ROWS) {
    const label = `rails=${row.rails} provider=${row.provider} price=${row.price} checkout_mode=${row.checkout_mode} sandboxAllowed=${row.sandboxAllowed}`;
    it(`${label}: shared resolver and buyer view match the specification`, () => {
      const mode = modeOf(row);
      const resolved = resolveCheckoutRails(railRowsFor(row), { ...POLICY, checkoutMode: mode });
      expect(resolved.kind).toBe("ok");
      const view = checkoutRailView(
        { checkout_mode: mode, price_usd: row.price === "set" ? "39.00" : null },
        usableRailsOf(resolved),
        row.sandboxAllowed === "true",
      );
      expect(view).toEqual(expectedOutcome(row));
    });
  }
});
