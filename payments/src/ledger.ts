import { mkdirSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { GLOBAL } from "./settings_registry.ts";

export type LedgerEventType = "sale" | "refund";

export interface SaleRecord {
  ts: string;
  sale_id: string;
  provider: string;
  product_id: string;
  amount_usd: number;
  creator_id: string;
  creator_split_pct: number;
  creator_split_usd: number;
  our_split_usd: number;
  currency: string;
  event_type?: LedgerEventType; // absent = "sale" (legacy records predate the field)
  email_hash?: string; // buyer-email sha256 from the webhook event (optional; never raw email)
}

// settings registry: global.json paths.sales_ledger (inline fallback keeps standalone runs working)
export const SALES_FILE: string = GLOBAL.paths.sales_ledger;

function assertSale(sale: SaleRecord): void {
  if (typeof sale !== "object" || sale === null) {
    throw new TypeError('ledger: sale must be an object with fields ts, sale_id, provider, product_id, amount_usd, creator_id, creator_split_pct, creator_split_usd, our_split_usd, currency');
  }
  const s = sale as Record<string, unknown>;
  const needStr = (key: string): void => {
    if (typeof s[key] !== "string" || (s[key] as string).trim() === "") {
      throw new TypeError(`ledger: "${key}" must be a non-empty string`);
    }
  };
  const needNum = (key: string): void => {
    if (typeof s[key] !== "number" || !Number.isFinite(s[key] as number)) {
      throw new TypeError(`ledger: "${key}" must be a finite number`);
    }
  };
  needStr("sale_id");
  needStr("provider");
  needStr("product_id");
  needStr("creator_id");
  needStr("currency");
  needNum("amount_usd");
  needNum("creator_split_pct");
  needNum("creator_split_usd");
  needNum("our_split_usd");
  const creatorSplitPct = s.creator_split_pct as number;
  if (creatorSplitPct < 0 || creatorSplitPct > 100) {
    throw new TypeError(`ledger: "creator_split_pct" must be within 0-100 (got ${creatorSplitPct})`);
  }
  if (Number.isNaN(Date.parse(s.ts as string))) {
    throw new TypeError('ledger: "ts" must be a parseable timestamp (UTC ISO string)');
  }
  if (s.event_type !== undefined && s.event_type !== "sale") {
    throw new TypeError('ledger: appendSale refused non-"sale" event_type — use appendRefund for refund records');
  }
}

/** Find an already-recorded sale by provider + sale_id (webhook idempotency guard).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as reports). */
export function findSale(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  let lines: string[];
  try {
    lines = readFileSync(salesFile, "utf8").split("\n");
  } catch {
    return null; // no ledger yet
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.provider === provider && o.sale_id === saleId) return o as SaleRecord;
    } catch {
      continue;
    }
  }
  return null;
}

/** Find an already-recorded REFUND by provider + sale_id (refund idempotency guard).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as reports). */
export function findRefund(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  let lines: string[];
  try {
    lines = readFileSync(salesFile, "utf8").split("\n");
  } catch {
    return null; // no ledger yet
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.event_type === "refund" && o.provider === provider && o.sale_id === saleId) return o as SaleRecord;
    } catch {
      continue;
    }
  }
  return null;
}

async function appendRecord(record: SaleRecord, salesFile: string): Promise<void> {
  mkdirSync(dirname(salesFile), { recursive: true });
  const fh = await open(salesFile, "a");
  try {
    await fh.writeFile(JSON.stringify(record) + "\n", "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function appendSale(sale: SaleRecord, salesFile: string = SALES_FILE): Promise<SaleRecord> {
  assertSale(sale);
  const record: SaleRecord = {
    ts: sale.ts,
    sale_id: sale.sale_id,
    provider: sale.provider,
    product_id: sale.product_id,
    amount_usd: sale.amount_usd,
    creator_id: sale.creator_id,
    creator_split_pct: sale.creator_split_pct,
    creator_split_usd: sale.creator_split_usd,
    our_split_usd: sale.our_split_usd,
    currency: sale.currency,
  };
  if (typeof sale.email_hash === "string" && sale.email_hash !== "") record.email_hash = sale.email_hash;
  await appendRecord(record, salesFile);
  return record;
}

export interface RefundSpec {
  provider: string;
  sale_id: string;
  ts?: string;
}

/** Append a refund record linked to a previously recorded sale. The refund is a FULL reversal
 *  of the linked sale (webhooks carry no refunded-amount field): amount_usd stays POSITIVE
 *  (semantically the refunded amount), creator/our splits are stored NEGATED so reports
 *  subtract them from income by plain summation. Refuses loudly when no recorded sale
 *  matches, or when a refund for the same sale was already recorded (idempotency guard). */
export async function appendRefund(refund: RefundSpec, salesFile: string = SALES_FILE): Promise<SaleRecord> {
  if (typeof refund !== "object" || refund === null) {
    throw new TypeError("ledger: refund must be an object {provider, sale_id, ts?}");
  }
  if (typeof refund.provider !== "string" || refund.provider.trim() === "") {
    throw new TypeError('ledger: refund "provider" must be a non-empty string');
  }
  if (typeof refund.sale_id !== "string" || refund.sale_id.trim() === "") {
    throw new TypeError('ledger: refund "sale_id" must be a non-empty string');
  }
  const ts = refund.ts ?? new Date().toISOString();
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) {
    throw new TypeError('ledger: refund "ts" must be a parseable timestamp (UTC ISO string)');
  }
  const original = findSale(refund.provider, refund.sale_id, salesFile);
  if (!original || original.event_type === "refund") {
    throw new Error(`ledger: refund refused — no recorded sale for provider=${refund.provider} sale_id=${refund.sale_id} (refunds must reference a recorded sale)`);
  }
  const already = findRefund(refund.provider, refund.sale_id, salesFile);
  if (already) {
    throw new Error(`ledger: refund already recorded for provider=${refund.provider} sale_id=${refund.sale_id} (refund idempotency guard)`);
  }
  const record: SaleRecord = {
    ts,
    sale_id: original.sale_id,
    provider: original.provider,
    product_id: original.product_id,
    amount_usd: original.amount_usd,
    creator_id: original.creator_id,
    creator_split_pct: original.creator_split_pct,
    creator_split_usd: -original.creator_split_usd,
    our_split_usd: -original.our_split_usd,
    currency: original.currency,
    event_type: "refund",
  };
  if (typeof original.email_hash === "string" && original.email_hash !== "") record.email_hash = original.email_hash;
  await appendRecord(record, salesFile);
  return record;
}
