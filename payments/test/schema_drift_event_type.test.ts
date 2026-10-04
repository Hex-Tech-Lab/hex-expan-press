// Schema-drift guard (Tenet 2): every event_type literal the ledger writes must be a
// legal value of the public.orders event_type CHECK constraint in the newest migration
// that defines it. Enum drift between code and DB is fatal — this test makes it so.
// Hermetic: reads only repo source files at runtime; no env, no network, no Supabase.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LEDGER_SRC = join(REPO_ROOT, "payments", "src", "ledger.ts");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/** Scan the ledger source for event_type literals it can persist.
 *  Contract pinned by construction: the three call sites that set/validate event_type
 *  (LedgerEventType union, persistToSupabaseOrder's `record.event_type || "sale"`
 *  default, and appendRefund/appendRefundReversal literals) all derive from the
 *  LedgerEventType union — extract it plus the explicit "sale" fallback. */
function ledgerEventTypes(): string[] {
  const src = readFileSync(LEDGER_SRC, "utf8");
  const types = new Set<string>();
  // The SSOT union: export type LedgerEventType = "sale" | "refund" | ...
  const union = src.match(/export type LedgerEventType = ([^;]+);/);
  if (!union) throw new Error("schema-drift: LedgerEventType union not found in ledger.ts — test contract broken");
  for (const m of union[1].matchAll(/"([a-z_]+)"/g)) types.add(m[1]);
  // The legacy-row default written to orders (absent event_type = "sale"):
  if (/record\.event_type \|\| "sale"/.test(src)) types.add("sale");
  if (types.size === 0) throw new Error("schema-drift: no event_type literals collected from ledger.ts");
  return [...types].sort();
}

/** Find the NEWEST migration that (re)defines the orders event_type CHECK constraint,
 *  and extract its permitted literals. Handles later migrations redefining the check
 *  (drop + add pattern) by taking the last one that adds the constraint. */
function checkConstraintLiterals(): { file: string; values: string[] } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // timestamp-prefixed names sort chronologically
  let hit: { file: string; values: string[] } | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // Match a check constraint over event_type that adds an IN-list, e.g.
    //   add constraint orders_event_type_check check (event_type in ('sale', 'refund'));
    // Allow newlines/whitespace between tokens (formatted SQL).
    const m = sql.match(/add\s+constraint\s+orders_event_type_check[\s\S]*?check\s*\(\s*event_type\s+in\s*\(([^)]*)\)/i);
    if (m) {
      const values = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      if (values.length > 0) hit = { file: f, values };
    }
  }
  if (!hit) throw new Error("schema-drift: no migration defines orders_event_type_check — test contract broken");
  return hit;
}

describe("schema drift: ledger event_type literals ⊆ orders.event_type CHECK constraint", () => {
  it("collects the ledger event_type literals (SSOT union)", () => {
    expect(ledgerEventTypes()).toEqual(["refund", "refund_reversal", "sale"]);
  });

  it("every ledger-written event_type is legal in the newest orders event_type CHECK migration", () => {
    const db = checkConstraintLiterals();
    const written = ledgerEventTypes();
    const illegal = written.filter((t) => !db.values.includes(t));
    expect(
      illegal,
      `ledger writes event types missing from ${db.file} CHECK (legal: ${db.values.join(", ")}) — F2-class enum drift`,
    ).toEqual([]);
  });

  it("the CHECK constraint itself is not narrower than the SSOT union minus legacy defaults", () => {
    // Guard against the test silently passing because the DB list shrank: every legal
    // DB value must still be known to the code (no half-removed enum values).
    const db = checkConstraintLiterals();
    const known = new Set(ledgerEventTypes());
    const unknown = db.values.filter((v) => !known.has(v));
    expect(
      unknown,
      `${db.file} CHECK admits values the ledger never writes — stale or foreign enum values`,
    ).toEqual([]);
  });
});
