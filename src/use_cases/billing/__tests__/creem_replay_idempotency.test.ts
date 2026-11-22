// Real-DB (PGlite) Creem webhook replay idempotency verification.
// Exercises the unmocked chain: CreemAdapter -> processBillingWebhookUseCase ->
// withIdempotencyLock -> persistSale (public.orders) -> deliverSaleForWebhook
// (delivery_sends, download_events, audit_log) -> mirrorToLocalLedger.
// Only Redis (stateful in-memory TTL store), Resend sendEmail, and Dub fetch are stubbed.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const ledgerState = vi.hoisted(() => {
  const dir = `/tmp/creem-replay-ledger-${Date.now()}-${globalThis.crypto.randomUUID()}`;
  return { dir, salesFile: `${dir}/sales.jsonl` };
});

const redisState = vi.hoisted(() => ({
  nowMs: 1_700_000_000_000,
  locks: new Map<string, { value: string; expiresAtMs: number }>(),
  counters: new Map<string, number>(),
  ttls: new Map<string, number>(),
}));

vi.mock("../../../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/infrastructure/redis/redis.client.ts")>()),
  expanRedis: {
    get: async (key: string) => {
      const entry = redisState.locks.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= redisState.nowMs) {
        redisState.locks.delete(key);
        return null;
      }
      return entry.value;
    },
    setnx: async (key: string, value: string | number, exSeconds?: number) => {
      const cur = redisState.locks.get(key);
      if (cur && cur.expiresAtMs > redisState.nowMs) return 0;
      const ttlMs = (exSeconds ?? 300) * 1000;
      redisState.locks.set(key, { value: String(value), expiresAtMs: redisState.nowMs + ttlMs });
      return 1;
    },
    incr: async (key: string) => {
      const next = (redisState.counters.get(key) ?? 0) + 1;
      redisState.counters.set(key, next);
      return next;
    },
    expire: async (key: string, exSeconds: number) => {
      redisState.ttls.set(key, exSeconds);
      return 1;
    },
    compareAndDel: async (key: string, expected: string) => {
      const cur = redisState.locks.get(key);
      if (!cur || cur.expiresAtMs <= redisState.nowMs) {
        redisState.locks.delete(key);
        return 0;
      }
      if (cur.value !== expected) return 0;
      redisState.locks.delete(key);
      return 1;
    },
  },
}));

vi.mock("../../../../payments/src/settings_registry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../payments/src/settings_registry.ts")>();
  return {
    ...actual,
    GLOBAL: {
      ...actual.GLOBAL,
      paths: { ...actual.GLOBAL.paths, sales_ledger: ledgerState.salesFile },
    },
    isEnabledPaymentProvider: (name: string) => name === "creem" || actual.isEnabledPaymentProvider(name),
  };
});

const sendEmailSpy = vi.hoisted(() => vi.fn(async () => ({ id: "resend_creem_1" })));

vi.mock("../../../../payments/src/email.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../payments/src/email.ts")>()),
  sendEmail: sendEmailSpy,
}));

const pgliteRef = vi.hoisted(() => ({
  db: null as PGlite | null,
  queue: Promise.resolve() as Promise<unknown>,
}));

type FilterOp =
  | { op: "eq" | "lte" | "gt" | "is"; col: string; val: unknown }
  | { op: "or"; arms: Array<{ col: string; val: string }> };

function makePgliteSupabaseClient(pg: PGlite) {
  const runSerialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pgliteRef.queue.then(fn, fn);
    pgliteRef.queue = next.catch(() => undefined);
    return next;
  };
  const serializeRow = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));

  const quoteCol = (col: string, alias?: string): string => {
    const prefix = alias ? `${alias}.` : "";
    if (col.includes("->>")) {
      const [jsonCol, key] = col.split("->>");
      return `(${prefix}${jsonCol}->>'${key.replace(/'/g, "''")}')`;
    }
    if (col.includes(".")) {
      const [tbl, c] = col.split(".");
      return `"${tbl.replace(/"/g, "")}"."${c.replace(/"/g, "")}"`;
    }
    return `${prefix}"${col.replace(/"/g, "")}"`;
  };

  const buildWhere = (filters: FilterOp[], startIdx = 1, alias?: string) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const f of filters) {
      if (f.op === "or") {
        const orClauses: string[] = [];
        for (const arm of f.arms) {
          orClauses.push(`${quoteCol(arm.col, alias)} = $${startIdx + params.length}`);
          params.push(arm.val);
        }
        clauses.push(`(${orClauses.join(" or ")})`);
        continue;
      }
      const expr = quoteCol(f.col, alias);
      if (f.op === "is" && f.val === null) {
        clauses.push(`${expr} is null`);
      } else if (f.op === "lte") {
        clauses.push(`${expr} <= $${startIdx + params.length}`);
        params.push(f.val);
      } else if (f.op === "gt") {
        clauses.push(`${expr} > $${startIdx + params.length}`);
        params.push(f.val);
      } else {
        clauses.push(`${expr} = $${startIdx + params.length}`);
        params.push(f.val);
      }
    }
    return { sql: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
  };

  return {
    from(table: string) {
      const cleanTable = table.replace(/"/g, "");
      const qTable = `public."${cleanTable}"`;
      let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
      let selectCols = "*";
      let returningCols: string | null = null;
      let payload: Record<string, unknown> | null = null;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | undefined;
      const filters: FilterOp[] = [];
      let orderSql = "";
      let limitSql = "";
      let wantMaybeSingle = false;

      const exec = async (): Promise<{ data: unknown; error: { code?: string; message: string } | null }> => {
        return runSerialized(async () => {
          try {
            if (mode === "insert") {
              const cols = Object.keys(payload!);
              const vals = Object.values(payload!);
              const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
              const ret = returningCols ? ` returning ${returningCols}` : "";
              const res = await pg.query(
                `insert into ${qTable} (${cols.map((c) => quoteCol(c)).join(", ")}) values (${placeholders})${ret}`,
                vals,
              );
              return { data: returningCols ? (res.rows as Record<string, unknown>[]).map(serializeRow) : null, error: null };
            }
            if (mode === "upsert") {
              const cols = Object.keys(payload!);
              const vals = Object.values(payload!);
              const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
              const conflictCols = (upsertOpts?.onConflict ?? "")
                .split(",")
                .map((s) => quoteCol(s.trim()))
                .join(", ");
              const conflictClause = upsertOpts?.ignoreDuplicates
                ? `on conflict (${conflictCols}) do nothing`
                : `on conflict (${conflictCols}) do update set ${cols.map((c) => `${quoteCol(c)} = excluded.${quoteCol(c)}`).join(", ")}`;
              const ret = returningCols ? ` returning ${returningCols}` : "";
              const res = await pg.query(
                `insert into ${qTable} (${cols.map((c) => quoteCol(c)).join(", ")}) values (${placeholders}) ${conflictClause}${ret}`,
                vals,
              );
              return { data: returningCols ? (res.rows as Record<string, unknown>[]).map(serializeRow) : null, error: null };
            }
            if (mode === "update") {
              const cols = Object.keys(payload!);
              const vals = Object.values(payload!);
              const setSql = cols.map((c, i) => `${quoteCol(c)} = $${i + 1}`).join(", ");
              const where = buildWhere(filters, vals.length + 1);
              const ret = returningCols ? ` returning ${returningCols}` : "";
              const res = await pg.query(
                `update ${qTable} set ${setSql} ${where.sql}${ret}`,
                [...vals, ...where.params],
              );
              return { data: returningCols ? (res.rows as Record<string, unknown>[]).map(serializeRow) : null, error: null };
            }
            if (mode === "delete") {
              const where = buildWhere(filters, 1);
              await pg.query(`delete from ${qTable} ${where.sql}`, where.params);
              return { data: null, error: null };
            }

            // Support embedded creators(handle) and product_rails!inner(...) used by resolveProductByAlias.
            if (cleanTable === "products" && selectCols.includes("creators(handle)")) {
              const hasRailInner = selectCols.includes("product_rails!inner(");
              const normalizedFilters = filters.map((f): FilterOp => {
                if (f.op === "eq" && f.col.includes(".")) return f;
                if (f.op === "or") return f;
                return f;
              });
              const where = buildWhere(normalizedFilters, 1, hasRailInner ? "products" : undefined);
              const railJoin = hasRailInner
                ? "inner join public.product_rails on product_rails.product_id = products.id"
                : "";
              const fromAlias = hasRailInner ? "products" : "products";
              const res = await pg.query(
                `select products.store_product_id, products.currency, products.provider, products.checkout_mode, creators.handle as _creator_handle
                 from public.products ${fromAlias}
                 left join public.creators on creators.id = products.creator_id
                 ${railJoin}
                 ${where.sql}${orderSql}${limitSql}`,
                where.params,
              );
              const rows = (res.rows as Array<Record<string, unknown>>).map((r) => {
                const { _creator_handle, ...rest } = serializeRow(r);
                return {
                  ...rest,
                  creators: typeof _creator_handle === "string" ? { handle: _creator_handle } : null,
                };
              });
              return { data: wantMaybeSingle ? (rows[0] ?? null) : rows, error: null };
            }

            const where = buildWhere(filters, 1);
            const colsSql = selectCols === "*" ? "*" : selectCols.split(",").map((c) => quoteCol(c.trim())).join(", ");
            const res = await pg.query(
              `select ${colsSql} from ${qTable} ${where.sql}${orderSql}${limitSql}`,
              where.params,
            );
            const rows = (res.rows as Record<string, unknown>[]).map(serializeRow);
            return { data: wantMaybeSingle ? (rows[0] ?? null) : rows, error: null };
          } catch (err) {
            const pgErr = err as { code?: string; message?: string };
            return { data: null, error: { code: pgErr.code, message: pgErr.message ?? String(err) } };
          }
        });
      };

      const chain = {
        select(cols = "*") {
          if (mode === "select") selectCols = cols;
          else returningCols = cols;
          return chain;
        },
        insert(row: Record<string, unknown>) {
          mode = "insert";
          payload = row;
          return chain;
        },
        upsert(row: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          mode = "upsert";
          payload = row;
          upsertOpts = opts;
          return chain;
        },
        update(row: Record<string, unknown>) {
          mode = "update";
          payload = row;
          return chain;
        },
        delete() {
          mode = "delete";
          return chain;
        },
        or(expr: string) {
          const arms = expr
            .split(",")
            .map((part) => {
              const m = part.trim().match(/^([A-Za-z0-9_]+)\.eq\.(.+)$/);
              if (!m) throw new Error(`Unsupported .or() arm in test shim: ${part}`);
              return { col: m[1], val: m[2] };
            });
          filters.push({ op: "or", arms });
          return chain;
        },
        eq(col: string, val: unknown) {
          filters.push({ op: "eq", col, val });
          return chain;
        },
        lte(col: string, val: unknown) {
          filters.push({ op: "lte", col, val });
          return chain;
        },
        gt(col: string, val: unknown) {
          filters.push({ op: "gt", col, val });
          return chain;
        },
        is(col: string, val: unknown) {
          filters.push({ op: "is", col, val });
          return chain;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderSql = ` order by ${quoteCol(col)} ${opts?.ascending === false ? "desc" : "asc"}`;
          return chain;
        },
        limit(n: number) {
          limitSql = ` limit ${Number(n)}`;
          return chain;
        },
        abortSignal() {
          return chain;
        },
        maybeSingle() {
          wantMaybeSingle = true;
          return exec();
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
          return exec().then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    if (!pgliteRef.db) throw new Error("PGlite not initialized");
    return makePgliteSupabaseClient(pgliteRef.db);
  },
}));

import { CreemAdapter } from "../../../adapters/payments/creem.adapter.ts";
import { processBillingWebhookUseCase } from "../process_billing_webhook.ts";
import { GLOBAL } from "../../../../payments/src/settings_registry.ts";
import { resetLastGenerationForTest } from "../../../../payments/src/delivery.ts";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const STORE_PRODUCT_ID = "house_creem_playbook_v1";
const CREEM_SECRET = "whsec_creem_replay_idempotency";
const TEST_LINK_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

const BASE_MIGRATIONS = `
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.creators (
    id uuid primary key,
    handle text not null unique,
    display_name text not null
  );
  create table public.products (
    id uuid primary key,
    creator_id uuid not null references public.creators(id),
    store_product_id text unique,
    title text not null,
    release_path text,
    currency text not null default 'USD',
    provider text,
    checkout_mode text
  );
  create table public.product_rails (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references public.products(id) on delete cascade,
    provider text not null,
    weight integer not null check (weight > 0),
    checkout_url text not null,
    active boolean not null default true,
    unique (product_id, provider)
  );
  create table public.creator_terms (
    id uuid primary key default gen_random_uuid(),
    creator_id uuid not null references public.creators(id),
    product_id uuid not null references public.products(id),
    effective_from timestamptz not null,
    creator_split_pct numeric(5,2) not null
  );
  create table public.audit_log (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    actor uuid,
    creator_id uuid,
    event text not null,
    details jsonb not null default '{}'::jsonb,
    idempotency_key text
  );
`;

const loadMigration = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../../../supabase/migrations", name), "utf8")
    .replace(/create policy[\s\S]*?;\n/gi, "")
    .replace(/notify pgrst[\s\S]*?;/gi, "")
    .replace(/insert into storage\.buckets[\s\S]*?;/gi, "");

let pg: PGlite;
let savedStoredSince: string;

function signedCreemDelivery(orderId: string, eventId = "evt_creem_replay_1") {
  const body = JSON.stringify({
    id: eventId,
    eventType: "checkout.completed",
    created_at: Date.parse("2026-11-22T12:00:00Z"),
    object: {
      id: `ch_${orderId}`,
      mode: "live",
      metadata: {
        order_ref: "ref_creem_replay",
        [GLOBAL.delivery.buyer_consent_metadata_key]: true,
      },
      order: {
        id: orderId,
        status: "paid",
        amount: 2900,
        amount_paid: 2900,
        currency: "usd",
        product: STORE_PRODUCT_ID,
        mode: "live",
      },
      customer: { email: "buyer@example.com" },
    },
  });
  const sig = createHmac("sha256", CREEM_SECRET).update(body).digest("hex");
  return {
    body,
    headers: { "creem-signature": sig, "content-type": "application/json" },
  };
}

describe("Creem webhook replay idempotency (real adapter -> ledger -> delivery)", () => {
  let dubLinkCalls = 0;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(BASE_MIGRATIONS);
    await pg.exec(loadMigration("20260927000200_orders_ledger.sql"));
    await pg.exec(loadMigration("20261003000200_orders_refund_reversal.sql"));
    await pg.exec(loadMigration("20261004000000_orders_provider_adjustment_id.sql"));
    await pg.exec(loadMigration("20261004000100_orders_adjustment_id_per_event.sql"));
    await pg.exec(loadMigration("20261119120000_orders_buyer_email_consent.sql"));
    await pg.exec(loadMigration("20261015120000_download_events.sql"));
    await pg.exec(loadMigration("20261019180000_download_events_generation_key.sql"));
    await pg.exec(loadMigration("20261020090000_download_events_generation_seq.sql"));
    await pg.exec(loadMigration("20261116170055_delivery_single_send_guard.sql"));
    await pg.exec(loadMigration("20261118120000_delivery_claim_link.sql"));
    await import("@supabase/supabase-js");
    pgliteRef.db = pg;
  }, 30_000);

  beforeEach(async () => {
    savedStoredSince = GLOBAL.delivery.stored_message_since;
    GLOBAL.delivery.stored_message_since = "2000-01-01T00:00:00.000Z";
    resetLastGenerationForTest(0);
    redisState.nowMs = 1_700_000_000_000;
    redisState.locks.clear();
    redisState.counters.clear();
    redisState.ttls.clear();
    sendEmailSpy.mockClear();
    dubLinkCalls = 0;
    mkdirSync(ledgerState.dir, { recursive: true });
    rmSync(ledgerState.salesFile, { force: true });

    await pg.exec(`
      delete from public.delivery_sends;
      delete from public.download_events;
      delete from public.orders;
      delete from public.audit_log;
      delete from public.creator_terms;
      delete from public.product_rails;
      delete from public.products;
      delete from public.creators;
    `);
    await pg.query("insert into public.creators (id, handle, display_name) values ($1, $2, $3)", [
      CREATOR_ID,
      "expanpress_house",
      "ExpanPress",
    ]);
    await pg.query(
      "insert into public.products (id, creator_id, store_product_id, title, release_path, currency, provider, checkout_mode) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [PRODUCT_ID, CREATOR_ID, STORE_PRODUCT_ID, "Creem Playbook", "releases/creem_playbook.pdf", "USD", "creem", "live"],
    );
    await pg.query(
      "insert into public.creator_terms (creator_id, product_id, effective_from, creator_split_pct) values ($1, $2, $3, $4)",
      [CREATOR_ID, PRODUCT_ID, "2026-01-01T00:00:00Z", 50],
    );

    vi.stubEnv("CREEM_WEBHOOK_SECRET", CREEM_SECRET);
    vi.stubEnv("SUPABASE_URL", "https://pglite.creem-replay.test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "pglite-secret");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.creem-replay.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "redis-token");
    vi.stubEnv("DUB_API_KEY", "dub_test_key");
    vi.stubEnv(GLOBAL.delivery.link_key_env, TEST_LINK_KEY_B64);

    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url) === "https://api.dub.co/links") {
        dubLinkCalls += 1;
        return new Response(JSON.stringify({ shortLink: `https://go.expanpress.com/creem_${dubLinkCalls}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected outbound fetch in test: ${String(url)}`);
    });
  });

  afterEach(() => {
    GLOBAL.delivery.stored_message_since = savedStoredSince;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(ledgerState.salesFile, { force: true });
  });

  it("post-TTL replay with request deadlineAt of identical Creem checkout.completed (sale_id = data.order.id) creates 1 order and 1 delivery", async () => {
    const first = signedCreemDelivery("ord_creem_replay_post_1", "evt_post_1");
    const replay = signedCreemDelivery("ord_creem_replay_post_1", "evt_post_2");

    await expect(
      processBillingWebhookUseCase({ ...first, deadlineAt: Date.now() + 10_000 }, [new CreemAdapter()]),
    ).resolves.toBeUndefined();

    // Advance Redis clock past the sale lock TTL so the replay re-acquires the lock and executes the full duplicate branch.
    redisState.nowMs += (GLOBAL.payments.webhook_lock_ttl_seconds + 5) * 1000;
    await expect(
      processBillingWebhookUseCase({ ...replay, deadlineAt: Date.now() + 10_000 }, [new CreemAdapter()]),
    ).resolves.toBeUndefined();

    const allOrders = await pg.query<{ count: string }>("select count(*)::text as count from public.orders");
    expect(Number(allOrders.rows[0]?.count)).toBe(1);

    const orders = await pg.query<{ provider: string; sale_id: string; buyer_email_consent: boolean | null }>(
      "select provider, sale_id, buyer_email_consent from public.orders where sale_id = $1",
      ["ord_creem_replay_post_1"],
    );
    expect(orders.rows).toEqual([
      { provider: "creem", sale_id: "ord_creem_replay_post_1", buyer_email_consent: true },
    ]);

    const localRows = readFileSync(ledgerState.salesFile, "utf8").split(/\r?\n/).filter(Boolean);
    expect(localRows).toHaveLength(1);
    expect(JSON.parse(localRows[0])).toMatchObject({ provider: "creem", sale_id: "ord_creem_replay_post_1" });

    const sends = await pg.query<{ state: string }>(
      "select state from public.delivery_sends where provider = 'creem' and sale_id = $1",
      ["ord_creem_replay_post_1"],
    );
    expect(sends.rows).toEqual([{ state: "sent" }]);

    const links = await pg.query<{ count: string }>(
      "select count(*)::text as count from public.download_events where sale_id = $1 and event_type = 'link_issued'",
      ["ord_creem_replay_post_1"],
    );
    expect(Number(links.rows[0]?.count)).toBe(1);

    const auditSent = await pg.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where event = 'DELIVERY_LINK_SENT' and details->>'provider' = 'creem' and details->>'sale_id' = $1",
      ["ord_creem_replay_post_1"],
    );
    expect(Number(auditSent.rows[0]?.count)).toBe(1);

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(dubLinkCalls).toBe(1);
  });

  it("within-TTL replay while lock is held confirms via orders + delivery_sends and triggers 1 order and 1 delivery", async () => {
    const first = signedCreemDelivery("ord_creem_replay_ttl_1", "evt_ttl_1");
    const replay = signedCreemDelivery("ord_creem_replay_ttl_1", "evt_ttl_2");

    await expect(processBillingWebhookUseCase(first, [new CreemAdapter()])).resolves.toBeUndefined();
    // Lock stays held when recorded=true; immediate replay hits WebhookInFlightError -> underLockOrConfirmed.
    await expect(processBillingWebhookUseCase(replay, [new CreemAdapter()])).resolves.toBeUndefined();

    const allTtlOrders = await pg.query<{ count: string }>("select count(*)::text as count from public.orders");
    expect(Number(allTtlOrders.rows[0]?.count)).toBe(1);

    const orders = await pg.query<{ count: string }>(
      "select count(*)::text as count from public.orders where provider = 'creem' and sale_id = $1",
      ["ord_creem_replay_ttl_1"],
    );
    expect(Number(orders.rows[0]?.count)).toBe(1);
    expect(readFileSync(ledgerState.salesFile, "utf8").split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(dubLinkCalls).toBe(1);
  });

  it("distinct data.order.id values produce distinct orders and deliveries (proves idempotency keys on data.order.id)", async () => {
    const first = signedCreemDelivery("ord_creem_distinct_1", "evt_dist_1");
    const second = signedCreemDelivery("ord_creem_distinct_2", "evt_dist_2");

    await expect(processBillingWebhookUseCase(first, [new CreemAdapter()])).resolves.toBeUndefined();
    await expect(processBillingWebhookUseCase(second, [new CreemAdapter()])).resolves.toBeUndefined();

    const orders = await pg.query<{ sale_id: string }>("select sale_id from public.orders order by sale_id asc");
    expect(orders.rows.map((r) => r.sale_id)).toEqual(["ord_creem_distinct_1", "ord_creem_distinct_2"]);
    expect(sendEmailSpy).toHaveBeenCalledTimes(2);
    expect(dubLinkCalls).toBe(2);
  });
});
