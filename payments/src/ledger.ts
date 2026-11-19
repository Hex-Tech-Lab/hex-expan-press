import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { bounded } from "./webhook_budget.ts";
import { GLOBAL, isMoneyPath } from "./settings_registry.ts";
import { getSupabaseAdmin } from "./supabase_admin.ts";
import { StaleFenceError } from "./delivery_errors.ts";

export { StaleFenceError };

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
  /** Buyer-supplied consent to email delivery (custom_data.buyer_consent). Recorded only; absent = not supplied (stored as NULL). */
  buyer_email_consent?: boolean;
  attribution_id?: string; // our own canonical cross-provider attribution ID (see provider.ts SaleEvent)
  provider_adjustment_id?: string; // provider's own adjustment id on refund/refund_reversal rows (replay dedupe); absent on sale rows
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

/** True when n carries at most `places` decimal digits. The tolerance scales with the magnitude (a few ULPs) so
 *  binary-float noise (0.1 + 0.2) passes while a real sub-cent value such as 39.000000001 does not. */
const hasAtMostDecimals = (n: number, places: number): boolean => {
  const scaled = n * 10 ** places;
  return Math.abs(scaled - Math.round(scaled)) <= 4 * Number.EPSILON * Math.max(1, Math.abs(scaled));
};

const usdColumn = (field: string, min: number) =>
  z.number().finite().min(min).max(99_999_999.99).refine((n) => hasAtMostDecimals(n, 2), { message: `${field} must be cent-exact (numeric(10,2))` });

/**
 * Write contract for public.orders, enforced immediately before the upsert so a malformed or
 * non-cent-exact value is rejected here (a terminal 400, no provider retry) instead of being
 * silently rounded or rejected by Postgres. A violation throws OrderSchemaError, which the webhook handler
 * quarantines and answers with a terminal 400 (no provider retry). Mirrors 20260927000200_orders_ledger.sql and the
 * event_type CHECK widened in 20261003000200. amount_usd is always non-negative; the splits are
 * negated on "refund" rows (appendRefund) and positive on "sale" / "refund_reversal" rows.
 */
export const OrderUpsertSchema = z.strictObject({
  provider: z.string().min(1),
  sale_id: z.string().min(1),
  product_id: z.string().min(1),
  creator_id: z.string().min(1),
  amount_usd: usdColumn("amount_usd", 0),
  creator_split_pct: z.number().finite().min(0).max(100).refine((n) => hasAtMostDecimals(n, 2), { message: "creator_split_pct must have at most 2 decimals (numeric(5,2))" }),
  creator_split_usd: usdColumn("creator_split_usd", -99_999_999.99),
  our_split_usd: usdColumn("our_split_usd", -99_999_999.99),
  currency: z.string().min(1),
  event_type: z.enum(["sale", "refund", "refund_reversal"]),
  email_hash: z.string().min(1).nullable(),
  attribution_id: z.string().min(1).nullable(),
  buyer_email_consent: z.boolean().nullable(),
  provider_adjustment_id: z.string().min(1).nullable(),
  occurred_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: "occurred_at must be a parseable timestamp" }),
}).superRefine((row, ctx) => {
  const wantNegative = row.event_type === "refund";
  for (const field of ["creator_split_usd", "our_split_usd"] as const) {
    const v = row[field];
    if (wantNegative ? v > 0 : v < 0) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must be ${wantNegative ? "<= 0" : ">= 0"} on a ${row.event_type} row` });
    }
  }
});
export class OrderSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderSchemaError";
  }
}

/** Parse the fence stored on a public.orders row. Only a non-negative safe integer (a JSON number, or its decimal
 *  string) is accepted. Anything else is a corrupt row, and throwing fails the write closed: Number(null) is 0, so a
 *  null fence would otherwise let a stale worker through. */
function parseStoredFence(raw: unknown): number {
  const fence = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(fence) || fence < 0) {
    throw new Error(`ledger: stored orders.fence is not a non-negative safe integer (got ${String(raw)})`);
  }
  return fence;
}

/** Dual-write an order record to Supabase public.orders for permanent serverless persistence.
 *  When a fencing token is supplied, enforces stored fence <= new fence via conditional update. */
async function persistToSupabaseOrder(record: SaleRecord, fence?: number): Promise<void> {
  if (fence !== undefined && (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 0)) {
    throw new TypeError("ledger: fence token must be a non-negative safe integer");
  }
  // Client construction stays inside the dual-write error boundary (Cubic P3,
  // PR #80 fix-forward): an import/createClient failure is logged and wrapped
  // exactly like any other dual-write failure. The null-guard (unconfigured
  // Supabase) remains OUTSIDE the try so the money-path throw keeps its own
  // unwrapped, pinned message.
  let supabase: Awaited<ReturnType<typeof getSupabaseAdmin>>;
  try {
    supabase = await getSupabaseAdmin();
  } catch (err) {
    console.error("ledger: Supabase dual-write exception:", err);
    throw new Error(`ledger: Supabase dual-write failed: ${(err as Error).message}`, { cause: err });
  }
  if (!supabase) {
    // Serverless /tmp is ephemeral: skipping the durable write there would lose the sale for good. Fail loud (500 → provider retries).
    // Money-path predicate (isMoneyPath), not a Vercel/Lambda env sniff: a prod-like runtime without VERCEL_ENV must also fail closed.
    if (isMoneyPath()) {
      throw new Error("ledger: SUPABASE_URL/SUPABASE_SECRET_KEY missing in a money-path runtime — refusing to record a ledger entry without the durable store");
    }
    return;
  }
  try {
    // Zod gate: the last check before the DB boundary. A violation throws OrderSchemaError; the handler quarantines it and
    // answers a terminal 400 (no retry). Nothing is written.
    const parsed = OrderUpsertSchema.safeParse({
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
      // ?? not ||: a recorded false must stay false, not become NULL.
      buyer_email_consent: record.buyer_email_consent ?? null,
      provider_adjustment_id: record.provider_adjustment_id || null,
      occurred_at: record.ts,
    });
    if (!parsed.success) {
      throw new OrderSchemaError(`ledger: orders row failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (fence === undefined) {
      const { error } = await supabase.from("orders").upsert(parsed.data, { onConflict: "provider,sale_id,event_type" });
      if (error) {
        // Keep the Postgres code: callers tell a replay (23505 on the adjustment-id index) from a real failure.
        throw Object.assign(new Error(`ledger: Supabase orders upsert failed: ${error.message}`), { code: error.code });
      }
      return;
    }

    const rowWithFence = { ...parsed.data, fence };
    const keyLabel = `${parsed.data.provider}:${parsed.data.sale_id}:${parsed.data.event_type}`;
    // An existing key takes only the fence. The financial fields of the committed row are never rewritten, so a duplicate or
    // conflicting payload cannot change what was booked. The full row is inserted only when the key is absent.
    const runFenceUpdate = async (): Promise<boolean> => {
      let query = supabase
        .from("orders")
        .update({ fence })
        .eq("provider", parsed.data.provider)
        .eq("sale_id", parsed.data.sale_id)
        .eq("event_type", parsed.data.event_type);
      if (parsed.data.provider_adjustment_id !== null) {
        query = query
          .eq("provider_adjustment_id", parsed.data.provider_adjustment_id)
          .eq("amount_usd", parsed.data.amount_usd)
          .eq("currency", parsed.data.currency);
      } else if (parsed.data.event_type !== "sale") {
        query = query
          .eq("amount_usd", parsed.data.amount_usd)
          .eq("currency", parsed.data.currency);
      }
      const { data, error } = await query
        .lte("fence", fence)
        .select("sale_id");
      if (error) {
        if (error.code === "40001") {
          throw new StaleFenceError("orders", keyLabel, fence);
        }
        throw Object.assign(new Error(`ledger: Supabase orders upsert failed: ${error.message}`), { code: error.code });
      }
      return Array.isArray(data) && data.length > 0;
    };

    if (await runFenceUpdate()) return;

    const { error: insertErr } = await supabase.from("orders").insert(rowWithFence);
    if (!insertErr) return;

    if (insertErr.code !== "23505" || isAdjustmentIdUniqueViolation(insertErr)) {
      throw Object.assign(new Error(`ledger: Supabase orders upsert failed: ${insertErr.message}`), { code: insertErr.code });
    }

    if (await runFenceUpdate()) return;

    const { data: stored, error: checkErr } = await supabase
      .from("orders")
      .select("fence")
      .eq("provider", parsed.data.provider)
      .eq("sale_id", parsed.data.sale_id)
      .eq("event_type", parsed.data.event_type)
      .maybeSingle();
    if (checkErr) {
      throw Object.assign(new Error(`ledger: Supabase orders upsert failed: ${checkErr.message}`), { code: checkErr.code });
    }
    // A row that exists but carries no usable fence is corrupt: parseStoredFence throws, so nothing is written.
    const storedFence = stored ? parseStoredFence((stored as { fence?: unknown }).fence) : undefined;
    if (storedFence !== undefined && storedFence > fence) {
      throw new StaleFenceError("orders", keyLabel, fence, storedFence);
    }
    throw Object.assign(new Error(`ledger: Supabase orders upsert failed: ${insertErr.message}`), { code: insertErr.code });
  } catch (err) {
    if (
      err instanceof OrderSchemaError ||
      err instanceof StaleFenceError ||
      (err instanceof Error && err.message.startsWith("ledger: Supabase orders upsert failed"))
    ) throw err;
    console.error("ledger: Supabase dual-write exception:", err);
    throw new Error(`ledger: Supabase dual-write failed: ${(err as Error).message}`, { cause: err });
  }
}

/** Minimal columns for public.orders queries matching OrdersRow (bans .select('*')). */
export const ORDERS_SELECT_COLUMNS = "occurred_at, created_at, sale_id, provider, product_id, amount_usd, creator_id, creator_split_pct, creator_split_usd, our_split_usd, currency, event_type, email_hash, attribution_id, provider_adjustment_id";

/** public.orders row as PostgREST returns it (numeric columns arrive as strings). */
interface OrdersRow {
  occurred_at?: string; created_at?: string; sale_id: string; provider: string; product_id: string;
  amount_usd: number | string; creator_id: string; creator_split_pct: number | string;
  creator_split_usd: number | string; our_split_usd: number | string; currency: string; event_type: string;
  email_hash?: string | null; attribution_id?: string | null; provider_adjustment_id?: string | null;
}

/** Map a public.orders row to a SaleRecord. */
function rowToSaleRecord(data: OrdersRow): SaleRecord {
  const rawTs = data.occurred_at || data.created_at;
  const ts = (rawTs as unknown) instanceof Date ? (rawTs as unknown as Date).toISOString() : String(rawTs);
  return {
    ts,
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
    attribution_id: data.attribution_id || undefined,
    provider_adjustment_id: data.provider_adjustment_id || undefined
  };
}

/** Read the local sales ledger. Only ENOENT means "no ledger yet" (null). Any other read error (EACCES, EIO, EISDIR)
 *  is logged and rethrown: a broken ledger must never look empty, or a duplicate check would pass and re-book a sale. */
function readLedgerText(salesFile: string): string | null {
  try {
    return readFileSync(salesFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error("ledger: sales ledger read failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Find an already-recorded sale by provider + sale_id (webhook idempotency guard).
 *  Missing file → null. Malformed lines are skipped; other read errors throw (see readLedgerText). */
export function findSale(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  salesFile = resolveSalesFile(salesFile);
  const text = readLedgerText(salesFile);
  if (text === null) return null; // no ledger yet
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.provider === provider && o.sale_id === saleId && (o.event_type === undefined || o.event_type === "sale")) {
        return o as unknown as SaleRecord;
      }
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : String(parseErr));
      continue; // malformed line — tolerated by contract
    }
  }
  return null;
}

/** Internal helper querying a single order row from Supabase public.orders with fail-closed semantics. */
async function queryOrderRowFromSupabase(
  filters: Record<string, string>,
  errorContext: string,
  signal?: AbortSignal,
): Promise<SaleRecord | null> {
  try {
    // Client construction inside the lookup error boundary (Cubic P3, PR #80
    // fix-forward): a construction failure is logged + rethrown by the catch
    // below instead of escaping raw.
    const supabase = await getSupabaseAdmin();
    if (!supabase) {
      // Unconfigured Supabase. In a money-path runtime a missing client must NOT read as "not found": a duplicate
      // check would pass and the sale, refund or reversal would be booked again. Outside it (local dev, tests) it is a clean miss.
      if (isMoneyPath()) throw new Error(`ledger: Supabase ${errorContext} unavailable: client not configured in a money-path runtime`);
      return null;
    }
    let query = supabase.from("orders").select(ORDERS_SELECT_COLUMNS);
    for (const [col, val] of Object.entries(filters)) {
      query = query.eq(col, val);
    }
    const { data, error } = await bounded(query, signal).maybeSingle();
    // Fail CLOSED: a lookup error is not "not found" — treating it as such would
    // let a duplicate delivery through. The route 500s and the provider retries.
    if (error) throw new Error(`ledger: Supabase ${errorContext} failed: ${error.message}`);

    if (!data) return null;

    return rowToSaleRecord(data);
  } catch (err) {
    console.error(`ledger: Supabase ${errorContext} failed:`, err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Asynchronously finds a sale, falling back to Supabase public.orders if not found in local file. */
export async function findSaleAsync(provider: string, saleId: string, salesFile: string = SALES_FILE, signal?: AbortSignal): Promise<SaleRecord | null> {
  const local = findSale(provider, saleId, salesFile);
  if (local) return local;

  return queryOrderRowFromSupabase(
    { provider, sale_id: saleId, event_type: "sale" },
    "sale lookup",
    signal,
  );
}

/** Duplicate-key guard on the partial unique index
 *  orders_provider_adjustment_id_uniq (provider, provider_adjustment_id, event_type) WHERE
 *  provider_adjustment_id IS NOT NULL. Only THAT index's violation is a webhook
 *  replay; anything else is a real failure and is never swallowed. */
export const ORDERS_ADJUSTMENT_UNIQ_INDEX = "orders_provider_adjustment_id_uniq";

export function isAdjustmentIdUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code !== "23505") return false;
  if (e.constraint === ORDERS_ADJUSTMENT_UNIQ_INDEX) return true;
  // PostgREST/Supabase REST surfaces the index name inside the message, not as a
  // structured field — match on the index name to avoid swallowing an unrelated
  // unique violation (e.g. the orders_provider_sale_event_type unique constraint).
  return typeof e.message === "string" && e.message.includes(ORDERS_ADJUSTMENT_UNIQ_INDEX);
}

/** Find an already-recorded row of eventType by (provider, provider_adjustment_id).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as findRefund). */
function findByProviderAdjustmentId(provider: string, providerAdjustmentId: string, eventType: "refund" | "refund_reversal", salesFile: string = SALES_FILE): SaleRecord | null {
  salesFile = resolveSalesFile(salesFile);
  const text = readLedgerText(salesFile);
  if (text === null) return null; // no ledger yet
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.provider === provider && o.provider_adjustment_id === providerAdjustmentId && o.event_type === eventType) {
        return o as unknown as SaleRecord;
      }
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : String(parseErr));
      continue; // malformed line — tolerated by contract
    }
  }
  return null;
}

/** Async twin of findByProviderAdjustmentId, backed by Supabase public.orders.
 *  Unconfigured Supabase returns null outside a money-path runtime and throws inside one; lookup errors FAIL CLOSED
 *  (throw) so a caller cannot mistake a broken lookup for "not a replay". */
export async function findByProviderAdjustmentIdAsync(provider: string, providerAdjustmentId: string, eventType: "refund" | "refund_reversal", salesFile: string = SALES_FILE): Promise<SaleRecord | null> {
  const local = findByProviderAdjustmentId(provider, providerAdjustmentId, eventType, salesFile);
  if (local) return local;

  return queryOrderRowFromSupabase(
    { provider, provider_adjustment_id: providerAdjustmentId, event_type: eventType },
    "adjustment-id lookup",
  );
}

/** Find an already-recorded REFUND by provider + sale_id (refund idempotency guard).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as reports). */
export function findRefund(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  salesFile = resolveSalesFile(salesFile);
  const text = readLedgerText(salesFile);
  if (text === null) return null; // no ledger yet
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.event_type === "refund" && o.provider === provider && o.sale_id === saleId) return o as unknown as SaleRecord;
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : String(parseErr));
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
  reason: z.enum([
    "amount_mismatch",
    "amount_unverifiable",
    "refund_not_settled",
    "currency_mismatch",
    "reversal_without_refund",
    "reversal_amount_mismatch",
    "reversal_amount_unverifiable",
    "refund_after_reversal",
    "adjustment_id_collision",
  ]),
  refund_cents: z.number().int().nonnegative().nullable(),
  sale_cents: z.number().int().nonnegative().nullable(),
  creator_id: z.string().nullable(),
  occurred_at: z.string(),
  // adjustment_id_collision forensics (optional: other reasons don't carry them). adjustment_id +
  // event_type + provider + reason form the dedupe identity (audit_log partial unique index), so a
  // provider retrying the 503 does not add a second flag row.
  adjustment_id: z.string().optional(),
  event_type: z.enum(["refund", "refund_reversal"]).optional(),
  incoming_currency: z.string().nullable().optional(),
  conflicting_sale_id: z.string().optional(),
  conflicting_cents: z.number().int().nonnegative().optional(),
  conflicting_currency: z.string().nullable().optional(),
}).strict().superRefine((v, ctx) => {
  // The collision dedupe index keys on these; a flag without them would bypass dedupe.
  if (v.reason !== "adjustment_id_collision") return;
  for (const k of ["adjustment_id", "event_type"] as const) {
    if (v[k] === undefined) ctx.addIssue({ code: "custom", path: [k], message: `${k} is required for adjustment_id_collision` });
  }
});
export type ManualReviewRefund = z.infer<typeof ManualReviewRefundSchema>;

export async function flagRefundForManualReview(input: ManualReviewRefund): Promise<void> {
  const details = ManualReviewRefundSchema.parse(input);
  const supabase = await getSupabaseAdmin();
  if (!supabase) {
    // Production: a flag that cannot be persisted must not become a quiet 400 —
    // throw so the webhook 500s and the provider retries until config is fixed.
    // Money-path detection (isMoneyPath): NODE_ENV=production, ANY VERCEL_ENV value
    // (previews included), or an AWS Lambda runtime — fail CLOSED when ambiguous.
    if (isMoneyPath()) {
      throw new Error("ledger: manual-review flag cannot be persisted: Supabase is not configured in a money-path runtime (production/previews/Lambda)");
    }
    console.error("ledger: MANUAL_REVIEW_REQUIRED_REFUND (Supabase unconfigured, not persisted):", details);
    return;
  }
  // Deterministic idempotency key (audit_log_idempotency_uidx, 20261004001000):
  // the key must identify the LOGICAL EVENT, not the review condition — otherwise
  // two distinct adjustments (or two distinct refunds) for one sale with the same
  // reason would collapse and the second event's details would never reach the
  // review queue. Identity: adjustment_id for collision flags, else refund_id,
  // else occurred_at (identical on provider redeliveries). Redeliveries of the
  // same event upsert to a no-op; distinct events each get their own row.
  const eventIdentity = details.adjustment_id ?? details.refund_id ?? details.occurred_at;
  const idempotencyKey = `MANUAL_REVIEW_REQUIRED_REFUND:${details.provider}:${details.sale_id}:${details.event_type ?? "none"}:${details.reason}:${eventIdentity}`;
  const { error } = await supabase
    .from("audit_log")
    .upsert(
      { event: "MANUAL_REVIEW_REQUIRED_REFUND", details, idempotency_key: idempotencyKey },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
  // ignoreDuplicates swallows the duplicate case; any other error is a real failure.
  if (error) throw new Error(`ledger: manual-review flag write failed: ${error.message}`);
}

/**
 * Durable reconciliation inbox for an adjustment-id collision (public.webhook_conflicts, migration
 * 20261004000800). One atomic RPC stores the normalized incoming event and the audit_log alert together;
 * the caller answers 202 only after this returns an id, so it THROWS whenever no row was written
 * (unconfigured Supabase included): a 202 without a durable row would drop the event for good.
 */
export interface WebhookConflictIncoming {
  provider: string;
  event_type: "refund" | "refund_reversal";
  sale_id: string;
  adjustment_id: string;
  total_cents: number | null;
  currency: string | null;
  occurred_at: string;
  refund_id: string | null;
}

export async function recordWebhookConflict(incoming: WebhookConflictIncoming, flag: ManualReviewRefund): Promise<number> {
  const details = ManualReviewRefundSchema.parse(flag);
  if (details.reason !== "adjustment_id_collision" || details.conflicting_sale_id === undefined || details.conflicting_cents === undefined) {
    throw new Error("ledger: webhook conflict requires an adjustment_id_collision flag with the conflicting row");
  }
  const supabase = await getSupabaseAdmin();
  if (!supabase) throw new Error("ledger: webhook conflict cannot be persisted: Supabase is not configured");
  // Fixed key order: the hash is the redelivery dedupe key, so it must not depend on object construction order.
  const normalized = {
    sale_id: incoming.sale_id,
    adjustment_id: incoming.adjustment_id,
    event_type: incoming.event_type,
    total_cents: incoming.total_cents,
    currency: incoming.currency,
    occurred_at: incoming.occurred_at,
    refund_id: incoming.refund_id,
  };
  const payloadSha256 = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const { data, error } = await supabase.rpc("record_webhook_conflict", {
    p_provider: incoming.provider,
    p_event_type: incoming.event_type,
    p_sale_id: incoming.sale_id,
    p_adjustment_id: incoming.adjustment_id,
    p_incoming: normalized,
    p_payload_sha256: payloadSha256,
    p_conflicting_sale_id: details.conflicting_sale_id,
    p_conflicting_amount_cents: details.conflicting_cents,
    p_conflicting_currency: details.conflicting_currency ?? null,
    p_flag_details: details,
  });
  if (error) throw new Error(`ledger: webhook conflict write failed: ${error.message}`);
  const id = typeof data === "string" ? Number(data) : data;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("ledger: webhook conflict write returned no id");
  return id;
}

/** Asynchronously finds a refund, falling back to Supabase public.orders if not found in local file. */
export async function findRefundAsync(provider: string, saleId: string, salesFile: string = SALES_FILE): Promise<SaleRecord | null> {
  const local = findRefund(provider, saleId, salesFile);
  if (local) return local;

  return queryOrderRowFromSupabase(
    { provider, sale_id: saleId, event_type: "refund" },
    "refund lookup",
  );
}

/** Find an already-recorded REFUND_REVERSAL by provider + sale_id (reversal idempotency guard). */
export function findRefundReversal(provider: string, saleId: string, salesFile: string = SALES_FILE): SaleRecord | null {
  salesFile = resolveSalesFile(salesFile);
  const text = readLedgerText(salesFile);
  if (text === null) return null; // no ledger yet
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.event_type === "refund_reversal" && o.provider === provider && o.sale_id === saleId) return o as unknown as SaleRecord;
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : String(parseErr));
      continue;
    }
  }
  return null;
}

/** Asynchronously finds a refund reversal, falling back to Supabase public.orders if not found in local file. */
export async function findRefundReversalAsync(provider: string, saleId: string, salesFile: string = SALES_FILE): Promise<SaleRecord | null> {
  const local = findRefundReversal(provider, saleId, salesFile);
  if (local) return local;

  return queryOrderRowFromSupabase(
    { provider, sale_id: saleId, event_type: "refund_reversal" },
    "refund_reversal lookup",
  );
}

/** True when the local ledger already holds a line for this (provider, sale_id, event_type). Malformed lines are skipped, as in findSale. */
function localLedgerHasKey(salesFile: string, record: SaleRecord): boolean {
  let text: string;
  try {
    text = readFileSync(salesFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    const normalized = err instanceof Error ? err : new Error(String(err));
    console.error("ledger: sales ledger read failed during the duplicate check:", normalized);
    throw normalized;
  }
  const eventType = record.event_type ?? "sale";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: Partial<SaleRecord>;
    try {
      parsed = JSON.parse(trimmed) as Partial<SaleRecord>;
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : String(parseErr));
      continue;
    }
    if (parsed.provider === record.provider && parsed.sale_id === record.sale_id && (parsed.event_type ?? "sale") === eventType) return true;
  }
  return false;
}

function appendRecord(record: SaleRecord, salesFile: string): Promise<void> {
  // The body is synchronous. A throw inside the executor rejects the promise, which is what an async function did,
  // so callers see the same behaviour and the same Promise<void> type.
  return new Promise<void>((resolve) => {
    // Serverless runtimes (Vercel/Lambda) have a read-only FS outside /tmp — keep the
    // ledger writable there by redirecting to the basename under /tmp.
    salesFile = resolveSalesFile(salesFile);
    mkdirSync(dirname(salesFile), { recursive: true });
    // The fenced orders row is the authoritative record; this file is derived from it. A key that is already present was written by
    // the worker that won the fence, so a stale worker must not append it again. The check and the append run in one synchronous
    // block, so no other handler in this process can interleave between them.
    if (!localLedgerHasKey(salesFile, record)) {
      const fd = openSync(salesFile, "a");
      try {
        writeSync(fd, JSON.stringify(record) + "\n", null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    resolve();
  });
}

/** Idempotent local mirror of a record that is already durable in Supabase. Duplicate paths call it: the durable write
 *  can commit while the local append then fails, and a retry finds the record only in Supabase. Without this the local
 *  ledger (what reports read) would stay short. A key already present locally is a no-op (appendRecord's check). */
export function mirrorToLocalLedger(record: SaleRecord, salesFile: string = SALES_FILE): Promise<void> {
  return appendRecord(record, salesFile);
}

/** Durable Supabase write of a sale, and nothing else. The first-sale webhook path calls this, delivers the receipt, and only
 *  then mirrors the sale locally, so a local-file fault can never block the buyer's email. appendSale composes the two for
 *  every other caller. */
export async function persistSale(sale: SaleRecord, fence?: number): Promise<SaleRecord> {
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
  if (typeof sale.buyer_email_consent === "boolean") record.buyer_email_consent = sale.buyer_email_consent;
  // Durable store FIRST: if Supabase fails the route 500s and the provider retries;
  // writing the local file first would make that retry look like a duplicate.
  await persistToSupabaseOrder(record, fence);
  return record;
}

export async function appendSale(sale: SaleRecord, salesFile: string = SALES_FILE, fence?: number): Promise<SaleRecord> {
  const record = await persistSale(sale, fence);
  await appendRecord(record, salesFile);
  return record;
}

/** Find all recorded sales matching a canonical attribution_id (cross-provider join).
 *  Tolerant read: missing file or malformed lines are skipped (same posture as findSale). */
export function findSalesByAttribution(attributionId: string, salesFile: string = SALES_FILE): SaleRecord[] {
  salesFile = resolveSalesFile(salesFile);
  const text = readLedgerText(salesFile);
  if (text === null) return []; // no ledger yet
  const lines = text.split(/\r?\n/);
  const out: SaleRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (o.attribution_id === attributionId) out.push(o as unknown as SaleRecord);
    } catch (parseErr) {
      console.error("ledger: malformed ledger line skipped:", parseErr instanceof Error ? parseErr.message : String(parseErr));
      continue; // malformed line — tolerated by contract
    }
  }
  return out;
}

export interface RefundSpec {
  provider: string;
  sale_id: string;
  ts?: string;
  /** Provider's own adjustment id (Paddle data.id on adjustment.*). When present the
   *  refund/refund_reversal row carries it for replay dedupe; sale rows never do. */
  provider_adjustment_id?: string;
}

/** Append a refund record linked to a previously recorded sale. The refund is a FULL reversal
 *  of the linked sale (webhooks carry no refunded-amount field): amount_usd stays POSITIVE
 *  (semantically the refunded amount), creator/our splits are stored NEGATED so reports
 *  subtract them from income by plain summation. Refuses loudly when no recorded sale
 *  matches, or when a refund for the same sale was already recorded (idempotency guard). */
export async function appendRefund(refund: RefundSpec, salesFile: string = SALES_FILE, fence?: number): Promise<SaleRecord> {
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
  // The Async helpers read the local file first and fall back to Supabase, so one call is the whole lookup.
  const original = await findSaleAsync(refund.provider, refund.sale_id, salesFile);
  if (!original || original.event_type === "refund") {
    throw new Error(`ledger: refund refused — no recorded sale for provider=${refund.provider} sale_id=${refund.sale_id} (refunds must reference a recorded sale)`);
  }
  const already = await findRefundAsync(refund.provider, refund.sale_id, salesFile);
  if (already) {
    if (fence !== undefined) {
      await persistToSupabaseOrder(already, fence);
    }
    await mirrorToLocalLedger(already, salesFile); // duplicate refund: heal a lost local append, then resolve with the existing record
    return already;
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
  if (typeof refund.provider_adjustment_id === "string" && refund.provider_adjustment_id !== "") record.provider_adjustment_id = refund.provider_adjustment_id;
  // Durable store FIRST: if Supabase fails the route 500s and the provider retries;
  // writing the local file first would make that retry look like a duplicate.
  await persistToSupabaseOrder(record, fence);
  await appendRecord(record, salesFile);
  return record;
}

/** Append a refund_reversal record linked to a previously recorded sale and refund.
 *  Restores the sale: amount_usd stays POSITIVE, creator/our splits are POSITIVE again.
 *  Record a reversal only if a refund exists for that sale_id/provider and no reversal exists yet.
 *  Duplicate reversal is a no-op (resolves with existing record). If no refund exists, throws error. */
export async function appendRefundReversal(spec: RefundSpec, salesFile: string = SALES_FILE, fence?: number): Promise<SaleRecord> {
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
  // The Async helpers read the local file first and fall back to Supabase, so one call is the whole lookup.
  const original = await findSaleAsync(spec.provider, spec.sale_id, salesFile);
  if (!original || original.event_type === "refund" || original.event_type === "refund_reversal") {
    throw new Error(`ledger: refund reversal refused — no recorded sale for provider=${spec.provider} sale_id=${spec.sale_id}`);
  }

  // Must have an existing refund
  const existingRefund = await findRefundAsync(spec.provider, spec.sale_id, salesFile);
  if (!existingRefund) {
    throw new Error(`ledger: refund reversal refused — no recorded refund for provider=${spec.provider} sale_id=${spec.sale_id} (reversals require an existing refund)`);
  }

  // Idempotency: if reversal already recorded, return it
  const alreadyReversal = await findRefundReversalAsync(spec.provider, spec.sale_id, salesFile);
  if (alreadyReversal) {
    if (fence !== undefined) {
      await persistToSupabaseOrder(alreadyReversal, fence);
    }
    await mirrorToLocalLedger(alreadyReversal, salesFile); // duplicate reversal: heal a lost local append
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
  if (typeof spec.provider_adjustment_id === "string" && spec.provider_adjustment_id !== "") record.provider_adjustment_id = spec.provider_adjustment_id;

  await persistToSupabaseOrder(record, fence);
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
