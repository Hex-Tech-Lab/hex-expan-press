// PICT pairwise test for webhook buyer consent parsing (provider x field x value).
// Paddle reads custom_data.buyer_consent; Creem metadata key is buyer_email_consent (never read by the Creem adapter).
// Model: docs/testing/pairwise/consent_parser.model.txt
// Rows:  docs/testing/pairwise/consent_parser.rows.tsv (16 generated PICT rows)
// Paddle drives PaddleAdapter.parseAndValidateWebhook; Creem drives CreemAdapter.parseAndValidateWebhook. No network.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaddleAdapter } from "../../src/adapters/payments/paddle.adapter";
import { CreemAdapter } from "../../src/adapters/payments/creem.adapter";
import { GLOBAL } from "../../payments/src/settings_registry";

const MODEL_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/consent_parser.model.txt");
const ROWS_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/consent_parser.rows.tsv");
const PICT_BIN = "/usr/local/bin/pict";
const EXPECTED_ROW_COUNT = 16;

const PADDLE_SECRET = crypto.randomBytes(16).toString("hex");
const CREEM_SECRET = "whsec_test_consent_fixture";
const PRICE_MAP = JSON.stringify({ pri_test_basic: "test_product_basic" });

type Provider = "paddle" | "creem";
type Field = "absent" | "null" | "present";
interface ConsentRow {
  rowNum: number;
  provider: Provider;
  field: Field;
  value: string;
}

function parseRows(tsv: string): ConsentRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as ConsentRow;
  });
}

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);

/** Raw model cell -> the JSON value the provider sends. Quoted cells are strings; bare cells are JSON literals. */
const VALUE_OF: Record<string, unknown> = {
  true: true,
  false: false,
  '"true"': "true",
  '"false"': "false",
  "1": 1,
  '"yes"': "yes",
  not_applicable: undefined,
};

const CONSENT_KEY = GLOBAL.payments.paddle.overlay.buyer_consent_key;

function paddleBody(field: Field, value: unknown): string {
  const custom: Record<string, unknown> = { product_id: "test_product_basic", email: "buyer@example.com" };
  if (field === "null") custom[CONSENT_KEY] = null;
  if (field === "present") custom[CONSENT_KEY] = value;
  return JSON.stringify({
    event_type: "transaction.completed",
    data: {
      id: "txn_consent_0001",
      currency_code: "USD",
      details: { totals: { total: "1000" } },
      items: [{ price: { id: "pri_test_basic" } }],
      custom_data: custom,
      changed_at: new Date().toISOString(),
    },
  });
}

function paddleSig(body: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const h1 = crypto.createHmac("sha256", Buffer.from(PADDLE_SECRET, "utf8")).update(`${ts}:${body}`, "utf8").digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function creemBody(field: Field, value: unknown): string {
  const metadata: Record<string, unknown> = { order_ref: "order-ref-123" };
  if (field === "null") metadata[GLOBAL.delivery.buyer_consent_metadata_key] = null;
  if (field === "present") metadata[GLOBAL.delivery.buyer_consent_metadata_key] = value;
  return JSON.stringify({
    id: "evt_consent_1",
    eventType: "checkout.completed",
    created_at: 1728734325927,
    object: {
      id: "ch_consent_1",
      mode: "live",
      metadata,
      order: {
        id: "ord_consent_1",
        status: "paid",
        amount: 1900,
        amount_paid: 1900,
        currency: "usd",
        product: "prod_test_1",
        mode: "live",
      },
      customer: { email: "buyer@example.com" },
    },
  });
}

function creemSig(body: string): string {
  return crypto.createHmac("sha256", CREEM_SECRET).update(body).digest("hex");
}

/** Parse one webhook and return the buyerEmailConsent the adapter produced (undefined when absent or dropped). */
async function parsedConsent(row: ConsentRow): Promise<{ ok: boolean; consent: unknown }> {
  const value = VALUE_OF[row.value];
  if (row.provider === "paddle") {
    vi.stubEnv("PADDLE_WEBHOOK_SECRET", PADDLE_SECRET);
    vi.stubEnv("PADDLE_ENVIRONMENT", "sandbox");
    vi.stubEnv("PADDLE_PRICE_MAP", PRICE_MAP);
    const body = paddleBody(row.field, value);
    const res = await new PaddleAdapter().parseAndValidateWebhook({ "paddle-signature": paddleSig(body) }, body);
    if (!res.isValid) return { ok: false, consent: undefined };
    return { ok: true, consent: res.event.eventType === "sale_completed" ? res.event.buyerEmailConsent : undefined };
  }
  vi.stubEnv("CREEM_WEBHOOK_SECRET", CREEM_SECRET);
  const body = creemBody(row.field, value);
  const res = await new CreemAdapter().parseAndValidateWebhook(
    { "creem-signature": creemSig(body), "content-type": "application/json" },
    body,
  );
  if (!res.isValid) return { ok: false, consent: undefined };
  return { ok: true, consent: (res.event as { buyerEmailConsent?: unknown }).buyerEmailConsent };
}

/** The expected buyerEmailConsent, from the parser contract. Creem never reads the metadata key, so it is always undefined. */
function expectedConsent(row: ConsentRow): unknown {
  if (row.provider === "creem") return undefined;
  if (row.field !== "present") return undefined;
  const value = VALUE_OF[row.value];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

describe("buyer consent parsing: PICT pairwise artifact integrity", () => {
  it("saved rows file matches live PICT output and covers all generated rows", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const liveOut = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(liveOut.trim()).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });
});

describe("buyer consent parsing: PICT pairwise rows", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(ROWS.map((r) => [r.rowNum, r] as const))("row %i", async (_n, row) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await parsedConsent(row);
    expect(result.ok).toBe(true);
    expect(result.consent).toBe(expectedConsent(row));

    // Only Paddle logs, and only a non-null value that is not true, "true", false or "false" (e.g. 1 or "yes").
    // Absent, null and the accepted strings stay silent. Creem never calls the parser, so it never logs.
    const malformed = row.field === "present" && VALUE_OF[row.value] !== undefined && expectedConsent(row) === undefined && row.provider === "paddle";
    if (malformed) expect(warn).toHaveBeenCalled();
    else expect(warn).not.toHaveBeenCalled();
  });
});

describe("buyer consent parsing: known gap", () => {
  // Documents the gap rather than locking it in. It passes while Creem drops metadata[buyer_email_consent].
  // When the Creem adapter starts recording consent, this flips to a failure. To switch it on: remove .fails here,
  // change expectedConsent() so Creem rows expect the parsed value (not undefined), and update the Paddle-only
  // warn condition in the per-row test so Creem malformed values are checked too.
  it.fails("Creem records metadata buyer_email_consent \"true\" as buyerEmailConsent true", async () => {
    vi.stubEnv("CREEM_WEBHOOK_SECRET", CREEM_SECRET);
    const body = creemBody("present", "true");
    const res = await new CreemAdapter().parseAndValidateWebhook(
      { "creem-signature": creemSig(body), "content-type": "application/json" },
      body,
    );
    expect(res.isValid).toBe(true);
    expect((res as { event: { buyerEmailConsent?: unknown } }).event.buyerEmailConsent).toBe(true);
  });
});
