import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { CreemAdapter } from "../creem.adapter.ts";

// Rows are PICT (order 2) output from data/intel/pairwise/test_gate_thanks.pict, PROJECTED onto the five columns
// the adapter reads: Mode, Flag, Database, Payment, Signature. Creator and Products are dropped because the adapter
// never receives them (they belong to the thank-you page), so projected rows can repeat. Pairwise coverage is
// claimed over those five columns only, under the model's constraint that Payment is paid only when Signature is valid.
type Row = {
  Mode: "live" | "test";
  Flag: "on" | "off";
  Database: "test_branch" | "production";
  Creator: string;
  Products: string;
  Payment: "paid" | "unpaid";
  Signature: "valid" | "invalid" | "missing";
};

const ROWS: Row[] = [
  { Mode: "live", Flag: "on", Database: "test_branch", Creator: "test_replica", Products: "one", Payment: "unpaid", Signature: "missing" },
  { Mode: "test", Flag: "off", Database: "production", Creator: "real_creator", Products: "many", Payment: "unpaid", Signature: "invalid" },
  { Mode: "live", Flag: "off", Database: "test_branch", Creator: "no_creator", Products: "none", Payment: "unpaid", Signature: "invalid" },
  { Mode: "live", Flag: "on", Database: "production", Creator: "test_replica", Products: "many", Payment: "paid", Signature: "valid" },
  { Mode: "test", Flag: "off", Database: "test_branch", Creator: "real_creator", Products: "one", Payment: "paid", Signature: "valid" },
  { Mode: "test", Flag: "on", Database: "production", Creator: "real_creator", Products: "many", Payment: "unpaid", Signature: "missing" },
  { Mode: "test", Flag: "on", Database: "production", Creator: "no_creator", Products: "none", Payment: "paid", Signature: "valid" },
  { Mode: "live", Flag: "off", Database: "test_branch", Creator: "real_creator", Products: "many", Payment: "unpaid", Signature: "missing" },
  { Mode: "test", Flag: "off", Database: "production", Creator: "test_replica", Products: "none", Payment: "unpaid", Signature: "missing" },
  { Mode: "test", Flag: "off", Database: "production", Creator: "no_creator", Products: "none", Payment: "unpaid", Signature: "missing" },
  { Mode: "live", Flag: "on", Database: "production", Creator: "test_replica", Products: "one", Payment: "unpaid", Signature: "invalid" },
  { Mode: "live", Flag: "on", Database: "test_branch", Creator: "test_replica", Products: "one", Payment: "unpaid", Signature: "valid" },
];

const SECRET = "whsec_pairwise_fixture";
const TEST_REF = "pairwise-test-ref";
const DB_URL: Record<Row["Database"], string> = {
  test_branch: `https://${TEST_REF}.supabase.co`,
  production: "https://prod-pairwise-ref.supabase.co",
};

function body(mode: "live" | "test", payment: "paid" | "unpaid"): string {
  return JSON.stringify({
    id: "evt_pw",
    eventType: "checkout.completed",
    created_at: 1728734325927,
    object: {
      id: "ch_pw",
      mode,
      metadata: { order_ref: "pw-ref" },
      order: { id: "ord_pw", status: payment === "paid" ? "paid" : "pending", amount: 1900, amount_paid: 1900, currency: "usd", product: "prod_pw", mode },
      customer: { email: "buyer@example.com" },
    },
  });
}

function headersFor(raw: string, signature: Row["Signature"]): Record<string, string> {
  if (signature === "missing") return { "content-type": "application/json" };
  const secret = signature === "valid" ? SECRET : "wrong-secret";
  return { "creem-signature": crypto.createHmac("sha256", secret).update(raw).digest("hex"), "content-type": "application/json" };
}

/** The expected outcome, written from the rules, not copied from the adapter. */
function expected(r: Row): "refused" | "ignored" | "sale" {
  if (r.Signature !== "valid") return "refused";
  const gateOpen = r.Flag === "on" && r.Database === "test_branch";
  if (r.Mode === "test" && !gateOpen) return "refused";
  if (r.Payment !== "paid") return "ignored";
  return "sale";
}

describe("Creem test gate: pairwise (PICT) rows", () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.CREEM_WEBHOOK_SECRET;
    process.env.CREEM_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.CREEM_WEBHOOK_SECRET;
    else process.env.CREEM_WEBHOOK_SECRET = prev;
  });

  it.each(ROWS)("$Mode / flag $Flag / $Database / $Payment / $Signature", async (r) => {
    const adapter = new CreemAdapter({ accept: r.Flag === "on", databaseRef: TEST_REF, supabaseUrl: DB_URL[r.Database] });
    const raw = body(r.Mode, r.Payment);
    const result = await adapter.parseAndValidateWebhook(headersFor(raw, r.Signature), raw);
    const want = expected(r);
    if (want === "refused") expect(result.isValid).toBe(false);
    if (want === "ignored") expect(result).toMatchObject({ isValid: true, event: { eventType: "ignored" } });
    if (want === "sale") expect(result).toMatchObject({ isValid: true, event: { eventType: "sale_completed", providerName: "creem" } });
  });
});

// The projected PICT rows contain no ACCEPTED test-mode sale (Mode test + flag on + test branch + paid + valid).
// The describe below covers that path explicitly, because it is the only path that lets the test cycle complete.
describe("Creem test gate: explicit accepted path (not generated by PICT)", () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.CREEM_WEBHOOK_SECRET;
    process.env.CREEM_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.CREEM_WEBHOOK_SECRET;
    else process.env.CREEM_WEBHOOK_SECRET = prev;
  });

  it("accepts a paid test-mode sale when the flag is on and the database is the test branch", async () => {
    const adapter = new CreemAdapter({ accept: true, databaseRef: TEST_REF, supabaseUrl: DB_URL.test_branch });
    const raw = body("test", "paid");
    const result = await adapter.parseAndValidateWebhook(headersFor(raw, "valid"), raw);
    expect(result).toMatchObject({ isValid: true, event: { eventType: "sale_completed" } });
  });

  it("refuses when the test flag is on but no test database ref is configured", async () => {
    const adapter = new CreemAdapter({ accept: true, databaseRef: "", supabaseUrl: DB_URL.test_branch });
    const raw = body("test", "paid");
    const result = await adapter.parseAndValidateWebhook(headersFor(raw, "valid"), raw);
    expect(result).toMatchObject({ isValid: false, httpStatus: 400 });
  });
});
