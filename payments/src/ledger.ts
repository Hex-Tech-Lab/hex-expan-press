import { mkdirSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { z } from "zod";
import { GLOBAL } from "./settings_registry.ts";

export type LedgerEventType = "sale" | "refund" | "refund_reversal";

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
  attribution_id?: string; // our own canonical cross-provider attribution ID (see provider.ts SaleEvent)
}

// settings registry: global.json paths.sales_ledger (inline fallback keeps standalone runs working)
export const SALES_FILE: string = GLOBAL.paths.sales_ledger;

function assertSale(sale: SaleRecord): void {
  if (typeof sale !== "object" || sale === null) {
    throw new TypeError('ledger: sale must be an object with fields ts, sale_id, provider, product_id, amount_usd, creator_id, creator_split_pct, creator_split_usd, our_split_usd, currency');
  }
  const saleFields = sale as unknown as Record<string, unknown>;
  const needStr = (key: string): void => {
    if (typeof saleFields[key] !== "string" || (saleFields[key] as string).trim() === "") {
      throw new TypeError(`ledger: "${key}" must be a non-empty string`);
    }
  };
  const needNum = (key: string): void => {
    if (typeof saleFields[key] !== "number" || !Number.isFinite(saleFields[key] as number)) {
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
  const creatorSplitPct = saleFields.creator_split_pct as number;
  if (creatorSplitPct < 0 || creatorSplitPct > 100) {
    throw new TypeError(`ledger: "creator_split_pct" must be within 0-100 (got ${creatorSplitPct})`);
  }
  if (Number.isNaN(Date.parse(saleFields.ts as string))) {
    throw new TypeError('ledger: "ts" must be a parseable timestamp (UTC ISO string)');
  }
  if (saleFields.event_type !== undefined && saleFields.event_type !== "sale") {
    throw new TypeError('ledger: appendSale refused non-"sale" event_type — use appendRefund for refund records');
  }
}

export function resolveSalesFile(salesFile: string = SALES_FILE): string {
  if ((process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) && salesFile === SALES_FILE) {
    return join("/tmp", basename(salesFile));
  }
  return salesFile;
}

/** Dual-write an order record to Supabase public.orders for permanent serverless persistence. */
async function persistToSupabaseOrder(record: SaleRecord): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const { error } = await supabase.from("orders").upsert({
      provider: record.provider,
      sale_id: record.sale_id,
      product_id: record.product_id,
      creator_id: record.creator_id,
      amount_usd: record.amount_usd,
      creator_split_pct: record.creator_split_pct,
      creator_split_usd: record.creator_split_usd,
      our_split_usd: record.our_split_usd,
      currency: record.currency,
      event_type: record.event_type || "sale",
      email_hash: record.email_hash || null,
      attribution_id: record.attribution_id || null,
      occurred_at: record.ts
    }, { onConflict: "provider,sale_id,event_type" });
    if (error) {
      throw new Error(`ledger: Supabase orders upsert failed: ${error.message}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("ledger: Supabase orders upsert failed")) throw err;
    console.error("ledger: Supabase dual-write exception:", err);
    throw new Error(`ledger: Supabase dual-write failed: ${(err as Error).message}`, { cause: err });
  }
}

/** Find an already-recorded sale by provider + sale_id (webhook idempotency guard).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as reports). */
export function findSale(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  salesFile = resolveSalesFile(salesFile);
  let lines: string[];
  try {
    lines = readFileSync(salesFile, "utf8").split(/\r?\n/);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("ledger: sales ledger read failed (treated as no ledger yet):", err);
    return null; // no ledger yet
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.provider === provider && o.sale_id === saleId) return o as unknown as SaleRecord;
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : parseErr);
      continue; // malformed line — tolerated by contract
    }
  }
  return null;
}

/** Asynchronously finds a sale, falling back to Supabase public.orders if not found in local file. */
export async function findSaleAsync(provider: string, saleId: string, salesFile: string = SALES_FILE): Promise<SaleRecord | null> {
  const local = findSale(provider, saleId, salesFile);
  if (local) return local;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("provider", provider)
      .eq("sale_id", saleId)
      .eq("event_type", "sale")
      .maybeSingle();
    // Fail CLOSED: a lookup error is not "not found" — treating it as such would
    // let a duplicate delivery through. The route 500s and the provider retries.
    if (error) throw new Error(`ledger: Supabase sale lookup failed: ${error.message}`);

    if (!data) return null;

    return {
      ts: data.occurred_at || data.created_at,
      sale_id: data.sale_id,
      provider: data.provider,
      product_id: data.product_id,
      amount_usd: Number(data.amount_usd),
      creator_id: data.creator_id,
      creator_split_pct: Number(data.creator_split_pct),
      creator_split_usd: Number(data.creator_split_usd),
      our_split_usd: Number(data.our_split_usd),
      currency: data.currency,
      event_type: data.event_type as LedgerEventType,
      email_hash: data.email_hash || undefined,
      attribution_id: data.attribution_id || undefined
    };
  } catch (err) {
    console.error("ledger: Supabase sale lookup failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Find an already-recorded REFUND by provider + sale_id (refund idempotency guard).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as reports). */
export function findRefund(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  salesFile = resolveSalesFile(salesFile);
  let lines: string[];
  try {
    lines = readFileSync(salesFile, "utf8").split(/\r?\n/);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("ledger: sales ledger read failed (treated as no ledger yet):", err);
    return null; // no ledger yet
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.event_type === "refund" && o.provider === provider && o.sale_id === saleId) return o as unknown as SaleRecord;
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : parseErr);
      continue; // malformed line — tolerated by contract
    }
  }
  return null;
}

/** AUDIT LOG IS APPEND-ONLY — NOT IDEMPOTENT. A provider that retries after a timed-out
 *  response (the insert may have committed) can produce duplicate
 *  MANUAL_REVIEW_REQUIRED_REFUND rows for the same refund. That is intentional: a
 *  duplicate alert is safer than a lost one. Downstream triage MUST deduplicate on
 *  (details->>'provider', details->>'sale_id') — plus details->>'refund_id' when present.
 *
 *  Durable dead-letter flag for a refund the ledger cannot represent (partial or
 *  mismatched amount). Written to the append-only public.audit_log as
 *  MANUAL_REVIEW_REQUIRED_REFUND so ops can query it after the provider stops
 *  retrying. Throws if Supabase is configured but the write fails, so the webhook
 *  answers 500 and the provider redelivers (the flag is never silently lost). */
const ManualReviewRefundSchema = z.object({
  provider: z.string().min(1),
  sale_id: z.string().min(1),
  refund_id: z.string().nullable(),
  reason: z.enum(["amount_mismatch", "amount_unverifiable"]),
  refund_cents: z.number().int().nonnegative().nullable(),
  sale_cents: z.number().int().nonnegative().nullable(),
  creator_id: z.string().nullable(),
  occurred_at: z.string(),
}).strict();
export type ManualReviewRefund = z.infer<typeof ManualReviewRefundSchema>;

export async function flagRefundForManualReview(input: ManualReviewRefund): Promise<void> {
  const details = ManualReviewRefundSchema.parse(input);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    // Production: a flag that cannot be persisted must not become a quiet 400 —
    // throw so the webhook 500s and the provider retries until config is fixed.
    if (process.env.VERCEL_ENV === "production") {
      throw new Error("ledger: manual-review flag cannot be persisted: Supabase is not configured in production");
    }
    console.error("ledger: MANUAL_REVIEW_REQUIRED_REFUND (Supabase unconfigured, not persisted):", details);
    return;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  const { error } = await supabase.from("audit_log").insert({ event: "MANUAL_REVIEW_REQUIRED_REFUND", details });
  if (error) throw new Error(`ledger: manual-review flag write failed: ${error.message}`);
}

/** Asynchronously finds a refund, falling back to Supabase public.orders if not found in local file. */
export async function findRefundAsync(provider: string, saleId: string, salesFile: string = SALES_FILE): Promise<SaleRecord | null> {
  const local = findRefund(provider, saleId, salesFile);
  if (local) return local;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("provider", provider)
      .eq("sale_id", saleId)
      .eq("event_type", "refund")
      .maybeSingle();
    // Fail CLOSED: a lookup error is not "not found" — treating it as such would
    // let a duplicate delivery through. The route 500s and the provider retries.
    if (error) throw new Error(`ledger: Supabase refund lookup failed: ${error.message}`);

    if (!data) return null;

    return {
      ts: data.occurred_at || data.created_at,
      sale_id: data.sale_id,
      provider: data.provider,
      product_id: data.product_id,
      amount_usd: Number(data.amount_usd),
      creator_id: data.creator_id,
      creator_split_pct: Number(data.creator_split_pct),
      creator_split_usd: Number(data.creator_split_usd),
      our_split_usd: Number(data.our_split_usd),
      currency: data.currency,
      event_type: data.event_type as LedgerEventType
    };
  } catch (err) {
    console.error("ledger: Supabase refund lookup failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Find an already-recorded REFUND_REVERSAL by provider + sale_id (reversal idempotency guard). */
export function findRefundReversal(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  salesFile = resolveSalesFile(salesFile);
  let lines: string[];
  try {
    lines = readFileSync(salesFile, "utf8").split(/\r?\n/);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("ledger: sales ledger read failed (treated as no ledger yet):", err);
    return null;
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.event_type === "refund_reversal" && o.provider === provider && o.sale_id === saleId) return o as unknown as SaleRecord;
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : parseErr);
      continue;
    }
  }
  return null;
}

/** Asynchronously finds a refund reversal, falling back to Supabase public.orders if not found in local file. */
export async function findRefundReversalAsync(provider: string, saleId: string, salesFile: string = SALES_FILE): Promise<SaleRecord | null> {
  const local = findRefundReversal(provider, saleId, salesFile);
  if (local) return local;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("provider", provider)
      .eq("sale_id", saleId)
      .eq("event_type", "refund_reversal")
      .maybeSingle();
    if (error) throw new Error(`ledger: Supabase refund_reversal lookup failed: ${error.message}`);
    if (!data) return null;

    return {
      ts: data.occurred_at || data.created_at,
      sale_id: data.sale_id,
      provider: data.provider,
      product_id: data.product_id,
      amount_usd: Number(data.amount_usd),
      creator_id: data.creator_id,
      creator_split_pct: Number(data.creator_split_pct),
      creator_split_usd: Number(data.creator_split_usd),
      our_split_usd: Number(data.our_split_usd),
      currency: data.currency,
      event_type: data.event_type as LedgerEventType
    };
  } catch (err) {
    console.error("ledger: Supabase refund_reversal lookup failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function appendRecord(record: SaleRecord, salesFile: string): Promise<void> {
  // Serverless runtimes (Vercel/Lambda) have a read-only FS outside /tmp — keep the
  // ledger writable there by redirecting to the basename under /tmp.
  salesFile = resolveSalesFile(salesFile);
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
  if (typeof sale.attribution_id === "string" && sale.attribution_id !== "") record.attribution_id = sale.attribution_id;
  // Durable store FIRST: if Supabase fails the route 500s and the provider retries;
  // writing the local file first would make that retry look like a duplicate.
  await persistToSupabaseOrder(record);
  await appendRecord(record, salesFile);
  return record;
}

/** Find all recorded sales matching a canonical attribution_id (cross-provider join).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as findSale). */
export function findSalesByAttribution(attributionId: string, salesFile: string = SALES_FILE): SaleRecord[] {
  salesFile = resolveSalesFile(salesFile);
  let lines: string[];
  try {
    lines = readFileSync(salesFile, "utf8").split(/\r?\n/);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error("ledger: sales ledger read failed (treated as empty):", err);
    return [];
  }
  const out: SaleRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.attribution_id === attributionId) out.push(o as unknown as SaleRecord);
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : parseErr);
      continue; // malformed line — tolerated by contract
    }
  }
  return out;
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
  let original = findSale(refund.provider, refund.sale_id, salesFile);
  if (!original) {
    original = await findSaleAsync(refund.provider, refund.sale_id, salesFile);
  }
  if (!original || original.event_type === "refund") {
    throw new Error(`ledger: refund refused — no recorded sale for provider=${refund.provider} sale_id=${refund.sale_id} (refunds must reference a recorded sale)`);
  }
  const already = findRefund(refund.provider, refund.sale_id, salesFile)
    ?? await findRefundAsync(refund.provider, refund.sale_id, salesFile);
  if (already) {
    return already; // duplicate refund → resolve with the existing record (no throw, no duplicate write)
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
  if (typeof original.attribution_id === "string" && original.attribution_id !== "") record.attribution_id = original.attribution_id;
  // Durable store FIRST: if Supabase fails the route 500s and the provider retries;
  // writing the local file first would make that retry look like a duplicate.
  await persistToSupabaseOrder(record);
  await appendRecord(record, salesFile);
  return record;
}

/** Append a refund_reversal record linked to a previously recorded sale and refund.
 *  Restores the sale: amount_usd stays POSITIVE, creator/our splits are POSITIVE again.
 *  Record a reversal only if a refund exists for that sale_id/provider and no reversal exists yet.
 *  Duplicate reversal is a no-op (resolves with existing record). If no refund exists, throws error. */
export async function appendRefundReversal(spec: RefundSpec, salesFile: string = SALES_FILE): Promise<SaleRecord> {
  if (typeof spec !== "object" || spec === null) {
    throw new TypeError("ledger: refund reversal must be an object {provider, sale_id, ts?}");
  }
  if (typeof spec.provider !== "string" || spec.provider.trim() === "") {
    throw new TypeError('ledger: refund reversal "provider" must be a non-empty string');
  }
  if (typeof spec.sale_id !== "string" || spec.sale_id.trim() === "") {
    throw new TypeError('ledger: refund reversal "sale_id" must be a non-empty string');
  }
  const ts = spec.ts ?? new Date().toISOString();
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) {
    throw new TypeError('ledger: refund reversal "ts" must be a parseable timestamp (UTC ISO string)');
  }
  let original = findSale(spec.provider, spec.sale_id, salesFile);
  if (!original) {
    original = await findSaleAsync(spec.provider, spec.sale_id, salesFile);
  }
  if (!original || original.event_type === "refund" || original.event_type === "refund_reversal") {
    throw new Error(`ledger: refund reversal refused — no recorded sale for provider=${spec.provider} sale_id=${spec.sale_id}`);
  }

  // Must have an existing refund
  const existingRefund = findRefund(spec.provider, spec.sale_id, salesFile)
    ?? await findRefundAsync(spec.provider, spec.sale_id, salesFile);
  if (!existingRefund) {
    throw new Error(`ledger: refund reversal refused — no recorded refund for provider=${spec.provider} sale_id=${spec.sale_id} (reversals require an existing refund)`);
  }

  // Idempotency: if reversal already recorded, return it
  const alreadyReversal = findRefundReversal(spec.provider, spec.sale_id, salesFile)
    ?? await findRefundReversalAsync(spec.provider, spec.sale_id, salesFile);
  if (alreadyReversal) {
    return alreadyReversal;
  }

  const record: SaleRecord = {
    ts,
    sale_id: original.sale_id,
    provider: original.provider,
    product_id: original.product_id,
    amount_usd: original.amount_usd,
    creator_id: original.creator_id,
    creator_split_pct: original.creator_split_pct,
    creator_split_usd: original.creator_split_usd,
    our_split_usd: original.our_split_usd,
    currency: original.currency,
    event_type: "refund_reversal",
  };
  if (typeof original.email_hash === "string" && original.email_hash !== "") record.email_hash = original.email_hash;
  if (typeof original.attribution_id === "string" && original.attribution_id !== "") record.attribution_id = original.attribution_id;

  await persistToSupabaseOrder(record);
  await appendRecord(record, salesFile);
  return record;
}

export interface ManualReviewQueueEntry {
  id: string | number;
  created_at: string;
  event: string;
  details: Record<string, unknown>;
  provider: string | null;
  sale_id: string | null;
  occurrences: number;
  incomplete: boolean; // true when provider/sale_id missing — kept as its own entry, never merged
}

/** Operational reader for the MANUAL_REVIEW_REQUIRED_REFUND dead-letter queue.
 *  Reads public.audit_log via Supabase REST using the same env resolution as the
 *  writer above (SUPABASE_URL + SUPABASE_SECRET_KEY). Deduplicates on
 *  (details->>'provider', details->>'sale_id') keeping the newest row per pair,
 *  with an occurrences count; rows missing provider or sale_id are kept
 *  standalone and flagged (incomplete: true). Throws when Supabase is
 *  configured but the request fails (HTTP non-2xx). */
export async function listManualReviewRefunds(opts?: {
  fetchImpl?: typeof fetch;
  limit?: number;
}): Promise<ManualReviewQueueEntry[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const limit = opts?.limit ?? GLOBAL.payments.review_queue_page_size;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return [];
  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/rest/v1/audit_log?select=id,created_at:at,event,details&event=eq.MANUAL_REVIEW_REQUIRED_REFUND&order=at.desc,id.desc&limit=${encodeURIComponent(String(limit))}`;
  const res = await fetchImpl(endpoint, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`ledger: audit_log review-queue read failed: HTTP ${res.status}`);
  }
  const rows = (await res.json()) as Array<{
    id: string | number;
    created_at: string;
    event: string;
    details: Record<string, unknown> | null;
  }>;
  const byPair = new Map<string, ManualReviewQueueEntry>();
  const standalone: ManualReviewQueueEntry[] = [];
  const stamp = (r: { id: string | number; created_at: string; event: string; details: Record<string, unknown> | null; provider: string | null; sale_id: string | null }): ManualReviewQueueEntry => ({
    id: r.id,
    created_at: r.created_at,
    event: r.event,
    details: r.details ?? {},
    provider: r.provider,
    sale_id: r.sale_id,
    occurrences: 1,
    incomplete: r.provider === null || r.sale_id === null,
  });
  for (const row of rows) {
    const provider = typeof row.details?.provider === "string" && row.details.provider !== "" ? row.details.provider : null;
    const saleId = typeof row.details?.sale_id === "string" && row.details.sale_id !== "" ? row.details.sale_id : null;
    const r = { ...row, provider, sale_id: saleId };
    if (provider === null || saleId === null) {
      standalone.push(stamp(r));
      continue;
    }
    const k = `${provider}\u0000${saleId}`;
    const prev = byPair.get(k);
    if (!prev) byPair.set(k, stamp(r));
    else prev.occurrences += 1;
  }
  // rows arrive newest-first (order=at.desc,id.desc; audit_log timestamp column is "at", aliased to created_at), so first sighting per
  // pair is the most recent; standalone entries preserve arrival order.
  return [...byPair.values(), ...standalone];
}
