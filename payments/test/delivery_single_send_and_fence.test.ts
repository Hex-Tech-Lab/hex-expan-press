// Verification suite for Option A (single buyer email per sale/send_kind enforced by
// public.delivery_sends) + Option B (monotonic Redis INCR fencing token across webhook_core,
// delivery, and ledger). Runs in-memory PGlite with the real SQL migration and mocks Redis
// and email — zero network calls, zero .env, zero external DB/Resend/Upstash writes.
import { readFileSync } from "node:fs";
import { mkdtempSync, readFileSync as readFsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const redisState = vi.hoisted(() => ({
  nowMs: 1_700_000_000_000,
  locks: new Map<string, { value: string; expiresAtMs: number }>(),
  counters: new Map<string, number>(),
  ttls: new Map<string, number>(),
}));

vi.mock("../../src/infrastructure/redis/redis.client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/infrastructure/redis/redis.client.ts")>()),
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

const pgliteRef = vi.hoisted(() => ({
  db: null as PGlite | null,
  queue: Promise.resolve() as Promise<unknown>,
}));

/** Minimal in-process PostgREST adapter backed by real PGlite for orders, delivery_sends, download_events, products, audit_log. */
function makePgliteSupabaseClient(pg: PGlite) {
  const runSerialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pgliteRef.queue.then(fn, fn);
    pgliteRef.queue = next.catch(() => undefined);
    return next;
  };
  const serializeRow = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
    );
  const quoteCol = (col: string): string => {
    if (col.includes("->>")) {
      const [jsonCol, key] = col.split("->>");
      return `(${jsonCol}->>'${key.replace(/'/g, "''")}')`;
    }
    return `"${col.replace(/"/g, "")}"`;
  };

  const buildWhere = (filters: Array<{ op: "eq" | "lte" | "gt" | "is"; col: string; val: unknown }>, startIdx = 1) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const f of filters) {
      const expr = quoteCol(f.col);
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
      const qTable = `public."${table.replace(/"/g, "")}"`;
      let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
      let selectCols = "*";
      let returningCols: string | null = null;
      let payload: Record<string, unknown> | null = null;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | undefined;
      const filters: Array<{ op: "eq" | "lte" | "gt" | "is"; col: string; val: unknown }> = [];
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
              `insert into ${qTable} (${cols.map(quoteCol).join(", ")}) values (${placeholders})${ret}`,
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
              `insert into ${qTable} (${cols.map(quoteCol).join(", ")}) values (${placeholders}) ${conflictClause}${ret}`,
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
          const where = buildWhere(filters, 1);
          const colsSql = selectCols === "*" ? "*" : selectCols.split(",").map((c) => quoteCol(c.trim())).join(", ");
          const res = await pg.query(
            `select ${colsSql} from ${qTable} ${where.sql}${orderSql}${limitSql}`,
            where.params,
          );
          const rows = (res.rows as Record<string, unknown>[]).map(serializeRow);
          if (wantMaybeSingle) {
            return { data: rows[0] ?? null, error: null };
          }
          return { data: rows, error: null };
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

import { withIdempotencyLock } from "../src/webhook_core.ts";
import { deliverSale, deliverSaleForWebhook, productionDeps, resetLastGenerationForTest, StaleFenceError } from "../src/delivery.ts";
import { listStuckDeliveryClaims } from "../src/delivery_sends_store.ts";
import { appendSale, appendRefund, type SaleRecord } from "../src/ledger.ts";
import { EmailSendError } from "../src/email.ts";
import { GLOBAL } from "../src/settings_registry.ts";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";

const BASE_MIGRATIONS = `
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.products (
    id uuid primary key,
    store_product_id text,
    paddle_product_id text,
    title text,
    release_path text
  );
  create table public.audit_log (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    actor uuid,
    creator_id uuid,
    event text not null,
    details jsonb not null default '{}'::jsonb
  );
`;

const ORDERS_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20260927000200_orders_ledger.sql"), "utf8")
  .replace(/create policy[\s\S]*?;\n/gi, "") // omit auth.uid()/creator_users policies not needed for service_role PGlite test
  .replace(/notify pgrst[\s\S]*?;/gi, "");
const ORDERS_REV_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261003000200_orders_refund_reversal.sql"), "utf8")
  .replace(/notify pgrst[\s\S]*?;/gi, "");
const ORDERS_ADJ_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261004000000_orders_provider_adjustment_id.sql"), "utf8")
  .replace(/notify pgrst[\s\S]*?;/gi, "");
const ORDERS_ADJ2_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261004000100_orders_adjustment_id_per_event.sql"), "utf8")
  .replace(/notify pgrst[\s\S]*?;/gi, "");
const DL_EVENTS_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261015120000_download_events.sql"), "utf8")
  .replace(/insert into storage\.buckets[\s\S]*?;/gi, "");
const DL_GEN_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261019180000_download_events_generation_key.sql"), "utf8");
const DL_SEQ_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261020090000_download_events_generation_seq.sql"), "utf8");
const GUARD_MIGRATION_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261116170055_delivery_single_send_guard.sql"), "utf8")
  .replace(/notify pgrst[\s\S]*?;/gi, "");
const CLAIM_LINK_MIGRATION_SQL = readFileSync(join(import.meta.dirname, "../../supabase/migrations/20261118120000_delivery_claim_link.sql"), "utf8")
  .replace(/notify pgrst[\s\S]*?;/gi, "");

let pg: PGlite;
let tmpDir: string;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(BASE_MIGRATIONS);
  await pg.exec(ORDERS_SQL);
  await pg.exec(ORDERS_REV_SQL);
  await pg.exec(ORDERS_ADJ_SQL);
  await pg.exec(ORDERS_ADJ2_SQL);
  await pg.exec(DL_EVENTS_SQL);
  await pg.exec(DL_GEN_SQL);
  await pg.exec(DL_SEQ_SQL);
  // Run the new migration TWICE to verify full idempotency.
  await pg.exec(GUARD_MIGRATION_SQL);
  await pg.exec(GUARD_MIGRATION_SQL);
  await pg.exec(CLAIM_LINK_MIGRATION_SQL);
  await pg.exec(CLAIM_LINK_MIGRATION_SQL);
  // Warm dynamic import so Vitest's vi.mock resolver does not race on the first concurrent import.
  await import("@supabase/supabase-js");
  pgliteRef.db = pg;
}, 30_000);

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "guard-test-"));
  resetLastGenerationForTest(0);
  redisState.nowMs = 1_700_000_000_000;
  redisState.locks.clear();
  redisState.counters.clear();
  redisState.ttls.clear();
  await pg.exec(`
    delete from public.delivery_sends;
    delete from public.download_events;
    delete from public.orders;
    delete from public.audit_log;
    delete from public.products;
  `);
  await pg.query(
    "insert into public.products (id, store_product_id, title, release_path) values ($1, $2, $3, $4)",
    [PRODUCT_ID, "alias-1", "Playbook", "releases/playbook.pdf"],
  );
  vi.stubEnv("SUPABASE_URL", "https://pglite.unit.test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "unit-test-secret");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.unit.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "unit-test-token");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function makeDeps(sendEmail: ReturnType<typeof vi.fn>, createShortLink?: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  return {
    ...productionDeps(),
    linkKey: Buffer.alloc(32, 7),
    sendEmail: sendEmail as unknown as (input: { to: string; subject: string; html: string; text: string; replyTo?: string }) => Promise<unknown>,
    createShortLink: (createShortLink ?? vi.fn(async (u: string) => `https://go.expanpress.com/x?to=${encodeURIComponent(u)}`)) as unknown as (u: string) => Promise<string>,
    timeoutMs,
  };
}

describe("Option A + Option B single-send guard & fencing tokens (cases a-d + SQL invariants)", () => {
  // These cases create claims with the database clock (now()). Claims created now must count as post-change, so the cutover is
  // moved before them for this block only. The legacy cases below set their own pre-change created_at.
  let savedSince: string;
  beforeEach(() => {
    savedSince = GLOBAL.delivery.stored_message_since;
    GLOBAL.delivery.stored_message_since = "2000-01-01T00:00:00.000Z";
  });
  afterEach(() => {
    GLOBAL.delivery.stored_message_since = savedSince;
  });

  it("migration invariants: RLS enabled, no policies, anon/authenticated revoked, functions search_path empty", async () => {
    const rls = await pg.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_catalog.pg_class where relname = 'delivery_sends' and relnamespace = 'public'::regnamespace",
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);

    const policies = await pg.query<{ count: string }>(
      "select count(*)::text as count from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'delivery_sends'",
    );
    expect(Number(policies.rows[0]?.count)).toBe(0);

    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const res = await pg.query<{ ok: boolean }>(
          "select has_table_privilege($1, 'public.delivery_sends', $2) as ok",
          [role, priv],
        );
        expect(res.rows[0]?.ok).toBe(false);
      }
    }

    const funcs = await pg.query<{ proname: string; proconfig: string[] | null }>(
      "select proname, proconfig from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname in ('delivery_sends_fence_guard', 'orders_fence_guard')",
    );
    expect(funcs.rows).toHaveLength(2);
    for (const f of funcs.rows) {
      expect(f.proconfig).toContain('search_path=""');
    }
  });

  it("case (a): two concurrent claims for the same sale and event produce one distinct email and one link", async () => {
    const sendEmail = vi.fn(async (_input: unknown) => ({ id: "email-1" }));
    const deps = makeDeps(sendEmail);
    const sale = { provider: "paddle", saleId: "sale-a-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    // The losing worker either resends the stored message (identical payload and key) or loses the store race and answers 503.
    // Either way no second distinct email is sent.
    const settled = await Promise.allSettled([
      deliverSale(sale, deps),
      deliverSale(sale, deps),
    ]);
    const fulfilled = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    expect(fulfilled).toContain("sent");
    expect(fulfilled.every((o) => o === "sent")).toBe(true);
    for (const s of settled) {
      if (s.status === "rejected") expect(s.reason).toMatchObject({ httpStatus: 503 });
    }
    const distinctPayloads = new Set(sendEmail.mock.calls.map((c) => JSON.stringify(c[0])));
    expect(distinctPayloads.size).toBe(1);
    expect(sendEmail.mock.calls.every((c) => (c[0] as { idempotencyKey?: string }).idempotencyKey === "paddle|sale-a-1|buyer_receipt")).toBe(true);
    const callsAfterConcurrent = sendEmail.mock.calls.length;

    const links = await pg.query<{ count: string }>(
      "select count(*)::text as count from public.download_events where sale_id = $1 and event_type = 'link_issued'",
      ["sale-a-1"],
    );
    expect(Number(links.rows[0]?.count)).toBe(1);

    const sends = await pg.query<{ state: string; fence: string }>(
      "select state, fence::text as fence from public.delivery_sends where provider = $1 and sale_id = $2 and send_kind = $3",
      ["paddle", "sale-a-1", GLOBAL.delivery.send_kind],
    );
    expect(sends.rows).toHaveLength(1);
    expect(sends.rows[0]?.state).toBe("sent");

    // Subsequent sequential claim for same provider/sale/kind is also a duplicate (still 1 email),
    // while a different provider with the same saleId is scoped independently.
    await expect(deliverSale({ ...sale, fence: 1 }, deps)).resolves.toBe("duplicate");
    await expect(deliverSale({ ...sale, provider: "fungies", fence: 1 }, deps)).resolves.toBe("sent");
    expect(sendEmail).toHaveBeenCalledTimes(callsAfterConcurrent + 1);
  });

  it("case (b): ambiguous failures (transport error, 5xx, timeout) keep state='claimed' and retries do not resend", async () => {
    const cases: Array<{ name: string; failWith: () => Promise<unknown>; timeoutMs?: number }> = [
      { name: "transport error", failWith: () => Promise.reject(new Error("socket hang up")) },
      { name: "Resend 5xx", failWith: () => Promise.reject(new EmailSendError("Resend error (503)", true, 503, false)) },
      { name: "timeout", failWith: () => new Promise<never>(() => {}), timeoutMs: 20 },
    ];

    for (const [idx, c] of cases.entries()) {
      const saleId = `sale-b-${idx}`;
      const sendEmail = vi.fn<(input: unknown) => Promise<unknown>>()
        .mockImplementationOnce(c.failWith)
        .mockResolvedValueOnce({ id: "should-never-send" });
      const deps = makeDeps(sendEmail, undefined, c.timeoutMs);
      const sale = { provider: "paddle", saleId, productAlias: "alias-1", buyerEmail: "buyer@example.com" };

      await expect(deliverSale({ ...sale, fence: 1 }, deps)).rejects.toThrow();

      const beforeRetry = await pg.query<{ state: string; fence: string }>(
        "select state, fence::text as fence from public.delivery_sends where provider = 'paddle' and sale_id = $1",
        [saleId],
      );
      expect(beforeRetry.rows).toEqual([{ state: "claimed", fence: "1" }]);

      // H1: a retry with a higher fence resends the stored message: the same payload under the same key.
      await expect(deliverSale({ ...sale, fence: 2 }, deps)).resolves.toBe("sent");
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(sendEmail.mock.calls[1][0]).toEqual(sendEmail.mock.calls[0][0]);

      const links = await pg.query<{ count: string }>(
        "select count(*)::text as count from public.download_events where sale_id = $1 and event_type = 'link_issued'",
        [saleId],
      );
      expect(Number(links.rows[0]?.count)).toBe(1);
    }

    // Contrast: definite 422 rejection frees the claim so a retry CAN send.
    const defSend = vi.fn<(input: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(new EmailSendError("Resend error (422)", false, 422, true))
      .mockResolvedValueOnce({ id: "email-def" });
    const defDeps = makeDeps(defSend);
    const defSale = { provider: "paddle", saleId: "sale-b-def", productAlias: "alias-1", buyerEmail: "buyer@example.com" };
    await expect(deliverSale({ ...defSale, fence: 1 }, defDeps)).rejects.toThrow("Resend error (422)");
    await expect(deliverSale({ ...defSale, fence: 2 }, defDeps)).resolves.toBe("sent");
    expect(defSend).toHaveBeenCalledTimes(2);
  });

  it("case (c): stale fence is rejected across deliverSale (claim, pre-send, markSent), ledger writes, and SQL triggers", async () => {
    const sendEmail = vi.fn(async (_input: unknown) => ({ id: "email-c" }));
    const deps = makeDeps(sendEmail);
    const sale = { provider: "paddle", saleId: "sale-c-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };

    // 1) Worker 2 claims & sends with fence=2; stale Worker 1 with fence=1 is rejected at claim.
    await expect(deliverSale({ ...sale, fence: 2 }, deps)).resolves.toBe("sent");
    await expect(deliverSale({ ...sale, fence: 1 }, deps)).rejects.toThrow(StaleFenceError);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // 2) Worker 1 (fence=1) claims first, stalls in createShortLink while Worker 2 (fence=2) supersedes;
    //    assertSendFence rejects Worker 1 BEFORE calling sendEmail.
    let releaseShortLink!: () => void;
    const shortLinkGate = new Promise<void>((r) => { releaseShortLink = r; });
    const slowSend = vi.fn(async () => ({ id: "slow" }));
    const slowShortLink = vi.fn(async (u: string) => {
      await shortLinkGate;
      return `https://go.expanpress.com/slow?to=${encodeURIComponent(u)}`;
    });
    const sale2 = { provider: "paddle", saleId: "sale-c-2", productAlias: "alias-1", buyerEmail: "buyer@example.com" };
    const p1 = deliverSale({ ...sale2, fence: 1 }, makeDeps(slowSend, slowShortLink));
    // Wait until Worker 1 has inserted its claim and entered createShortLink
    await vi.waitFor(() => expect(slowShortLink).toHaveBeenCalledTimes(1));
    // Worker 2 arrives with fence=2 before Worker 1 has stored a message. It takes the claim and mints its own message.
    // (Before this fix it answered 'duplicate' and the sale was stranded.)
    await expect(deliverSale({ ...sale2, fence: 2 }, makeDeps(slowSend))).resolves.toBe("sent");
    releaseShortLink();
    // Worker 1 is stale: its fence assertion fails before any send, so only Worker 2's email went out.
    await expect(p1).rejects.toThrow(StaleFenceError);
    expect(slowSend).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(slowSend.mock.calls[0])).not.toContain("/slow?to=");

    // 3) Stale fence on ledger writes (appendSale + appendRefund): fence=2 succeeds, stale fence=1 rejected.
    const salesFile = join(tmpDir, "sales.jsonl");
    const staleFile = join(tmpDir, "stale_sales.jsonl");
    const orderRecord: SaleRecord = {
      ts: "2026-11-16T12:00:00.000Z",
      sale_id: "sale-c-order",
      provider: "paddle",
      product_id: "alias-1",
      amount_usd: 39,
      creator_id: "creator_1",
      creator_split_pct: 50,
      creator_split_usd: 19.5,
      our_split_usd: 19.5,
      currency: "USD",
    };
    await appendSale(orderRecord, salesFile, 2);
    await expect(appendSale({ ...orderRecord, amount_usd: 99 }, staleFile, 1)).rejects.toThrow(StaleFenceError);

    const row = await pg.query<{ amount_usd: string; fence: string }>(
      "select amount_usd::text, fence::text from public.orders where provider = 'paddle' and sale_id = 'sale-c-order' and event_type = 'sale'",
    );
    expect(Number(row.rows[0]?.amount_usd)).toBe(39);
    expect(row.rows[0]?.fence).toBe("2");
    expect(() => readFsSync(staleFile, "utf8")).toThrow();

    await appendRefund({ provider: "paddle", sale_id: "sale-c-order", ts: "2026-11-16T12:05:00.000Z" }, salesFile, 2);
    await expect(
      appendRefund({ provider: "paddle", sale_id: "sale-c-order", ts: "2026-11-16T12:06:00.000Z" }, staleFile, 1),
    ).rejects.toThrow(StaleFenceError);

    // 4) Direct SQL trigger check: even raw UPDATE cannot lower fence or revert 'sent' -> 'claimed'.
    await expect(
      pg.query("update public.delivery_sends set fence = 1 where provider = 'paddle' and sale_id = 'sale-c-1'"),
    ).rejects.toThrow(/stale fence token/);
    await expect(
      pg.query("update public.delivery_sends set state = 'claimed' where provider = 'paddle' and sale_id = 'sale-c-1'"),
    ).rejects.toThrow(/invalid state transition/);
    await expect(
      pg.query("update public.orders set fence = 1 where provider = 'paddle' and sale_id = 'sale-c-order' and event_type = 'sale'"),
    ).rejects.toThrow(/stale fence token/);
  });

  it("case (d): simulated lock expiry with two overlapping workers produces exactly one link and one email", async () => {
    // Timing 1: Worker 1 pauses inside sendEmail past lock TTL (300s); Worker 2 acquires expired lock
    // with fence=2, sees Option A claim, sends nothing; Worker 1 wakes up and its markDeliverySent(fence=1) is rejected.
    const salesFile = join(tmpDir, "expiry1.jsonl");
    let worker1InSend!: () => void;
    const worker1InSendDone = new Promise<void>((r) => { worker1InSend = r; });
    let releaseWorker1Send!: () => void;
    const worker1SendGate = new Promise<void>((r) => { releaseWorker1Send = r; });

    const sendEmail1 = vi.fn(async (_input: unknown) => {
      worker1InSend();
      await worker1SendGate;
      return { id: "e-w1" };
    });
    const sendEmail2 = vi.fn(async (_input: unknown) => ({ id: "e-w2" }));
    const lockKey = `${GLOBAL.payments.webhook_lock_sale_prefix}paddle:sale-d-1`;

    const runWorker = (workerSend: ReturnType<typeof vi.fn>) =>
      withIdempotencyLock(lockKey, async (fence) => {
        await appendSale(
          {
            ts: "2026-11-16T12:00:00.000Z",
            sale_id: "sale-d-1",
            provider: "paddle",
            product_id: "alias-1",
            amount_usd: 39,
            creator_id: "creator_1",
            creator_split_pct: 50,
            creator_split_usd: 19.5,
            our_split_usd: 19.5,
            currency: "USD",
          },
          salesFile,
          fence,
        );
        await deliverSaleForWebhook(
          { provider: "paddle", saleId: "sale-d-1", productAlias: "alias-1", buyerEmail: "buyer@example.com", fence },
          makeDeps(workerSend),
        );
        return { status: 200, payload: { ok: true, recorded: true } };
      });

    const pWorker1 = runWorker(sendEmail1);
    await worker1InSendDone;

    // Advance clock past lock TTL (300s) so Redis lock expires while Worker 1 is stalled in sendEmail.
    redisState.nowMs += (GLOBAL.payments.webhook_lock_ttl_seconds + 1) * 1000;

    // Worker 2 acquires lock with fence=2 and runs overlapping with stalled Worker 1.
    // Worker 2 owns fence 2 and finds Worker 1's stored message: it resends those exact bytes under the same key.
    const res2 = await runWorker(sendEmail2);
    expect(res2.status).toBe(200);
    expect(sendEmail2).toHaveBeenCalledTimes(1);
    expect(sendEmail2.mock.calls[0][0]).toEqual(sendEmail1.mock.calls[0][0]);

    // Release Worker 1: markDeliverySent(fence=1) is rejected as stale (stored fence is 2).
    releaseWorker1Send();
    await expect(pWorker1).rejects.toThrow(StaleFenceError);

    expect(sendEmail1).toHaveBeenCalledTimes(1);
    expect(sendEmail2).toHaveBeenCalledTimes(1);

    const links1 = await pg.query<{ count: string }>(
      "select count(*)::text as count from public.download_events where sale_id = 'sale-d-1' and event_type = 'link_issued'",
    );
    expect(Number(links1.rows[0]?.count)).toBe(1);

    // Timing 2: Worker 1 pauses BEFORE appendSale/deliverSale past TTL; Worker 2 finishes with fence=2;
    // Worker 1 resumes with stale fence=1 and is rejected before writing or sending.
    const salesFile2 = join(tmpDir, "expiry2.jsonl");
    let worker1BeforeWrite!: () => void;
    const worker1BeforeWriteDone = new Promise<void>((r) => { worker1BeforeWrite = r; });
    let releaseWorker1Write!: () => void;
    const worker1WriteGate = new Promise<void>((r) => { releaseWorker1Write = r; });

    const lockKey2 = `${GLOBAL.payments.webhook_lock_sale_prefix}paddle:sale-d-2`;
    const sendA = vi.fn(async () => ({ id: "e-a" }));
    const sendB = vi.fn(async () => ({ id: "e-b" }));

    const pSlow = withIdempotencyLock(lockKey2, async (fence) => {
      worker1BeforeWrite();
      await worker1WriteGate;
      await appendSale(
        {
          ts: "2026-11-16T12:00:00.000Z",
          sale_id: "sale-d-2",
          provider: "paddle",
          product_id: "alias-1",
          amount_usd: 39,
          creator_id: "creator_1",
          creator_split_pct: 50,
          creator_split_usd: 19.5,
          our_split_usd: 19.5,
          currency: "USD",
        },
        salesFile2,
        fence,
      );
      await deliverSaleForWebhook(
        { provider: "paddle", saleId: "sale-d-2", productAlias: "alias-1", buyerEmail: "buyer@example.com", fence },
        makeDeps(sendA),
      );
      return { status: 200, payload: { ok: true, recorded: true } };
    });

    await worker1BeforeWriteDone;
    redisState.nowMs += (GLOBAL.payments.webhook_lock_ttl_seconds + 1) * 1000;

    await withIdempotencyLock(lockKey2, async (fence) => {
      await appendSale(
        {
          ts: "2026-11-16T12:00:00.000Z",
          sale_id: "sale-d-2",
          provider: "paddle",
          product_id: "alias-1",
          amount_usd: 39,
          creator_id: "creator_1",
          creator_split_pct: 50,
          creator_split_usd: 19.5,
          our_split_usd: 19.5,
          currency: "USD",
        },
        salesFile2,
        fence,
      );
      await deliverSaleForWebhook(
        { provider: "paddle", saleId: "sale-d-2", productAlias: "alias-1", buyerEmail: "buyer@example.com", fence },
        makeDeps(sendB),
      );
      return { status: 200, payload: { ok: true, recorded: true } };
    });

    releaseWorker1Write();
    await expect(pSlow).rejects.toThrow(StaleFenceError);
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).toHaveBeenCalledTimes(1);

    const links2 = await pg.query<{ count: string }>(
      "select count(*)::text as count from public.download_events where sale_id = 'sale-d-2' and event_type = 'link_issued'",
    );
    expect(Number(links2.rows[0]?.count)).toBe(1);
    const sends2 = await pg.query<{ state: string; fence: string }>(
      "select state, fence::text as fence from public.delivery_sends where provider = 'paddle' and sale_id = 'sale-d-2'",
    );
    expect(sends2.rows).toEqual([{ state: "sent", fence: "2" }]);
  });
});

// B2 + H1: a held claim resends its stored message (identical bytes, same idempotency key) and is never a silent 200.
// A held claim with NO stored message (a pre-migration row) cannot be resent identically, and a new link could be a second
// email, so it is never resent or re-minted: it is flagged for manual reconciliation and answers 503.
describe("stuck claim visibility (B2 + H1): held claims resend the stored message; rows without one are flagged for manual reconciliation", () => {
  it("a held claim resends its stored message identically and logs no manual flag", async () => {
    const sendEmail = vi.fn<(input: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ id: "resent" });
    const deps = makeDeps(sendEmail);
    const sale = { provider: "paddle", saleId: "sale-h-1", productAlias: "alias-1", buyerEmail: "buyer@example.com" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale({ ...sale, fence: 1 }, deps)).rejects.toMatchObject({ httpStatus: 503 });

      await expect(deliverSale({ ...sale, fence: 2 }, deps)).resolves.toBe("sent");
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("MANUAL RECONCILE"))).toBe(false);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(sendEmail.mock.calls[1][0]).toEqual(sendEmail.mock.calls[0][0]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a held claim with no stored message is never resent or re-minted: 503, nothing sent, flagged for manual reconciliation", async () => {
    const sendEmail = vi.fn<(input: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ id: "minted" });
    const deps = makeDeps(sendEmail);
    const sale = { provider: "paddle", saleId: "sale-h-2", productAlias: "alias-1", buyerEmail: "buyer@example.com" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(deliverSale({ ...sale, fence: 1 }, deps)).rejects.toMatchObject({ httpStatus: 503 });
      // Simulate a pre-migration held row: no stored message.
      await pg.exec("update public.delivery_sends set link_ciphertext = null, created_at = '2026-11-01T00:00:00Z' where sale_id = 'sale-h-2'");

      await expect(deliverSale({ ...sale, fence: 3 }, deps)).rejects.toMatchObject({ httpStatus: 503 });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("MANUAL RECONCILE sale=sale-h-2 provider=paddle"))).toBe(true);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls.flat().map(String).join("\n")).not.toContain("buyer@example.com");
      const rows = await pg.query("select state from public.delivery_sends where sale_id = 'sale-h-2'");
      expect(rows.rows).toEqual([{ state: "claimed" }]); // kept for the operator, not re-minted
    } finally {
      errSpy.mockRestore();
    }
  });

  it("listStuckDeliveryClaims returns only 'claimed' rows at least the threshold old", async () => {
    await pg.exec(`
      insert into public.delivery_sends (provider, sale_id, send_kind, fence, state, created_at) values
        ('paddle', 'stuck-1', 'buyer_receipt', 1, 'claimed', now() - interval '2 hours'),
        ('paddle', 'fresh-1', 'buyer_receipt', 1, 'claimed', now()),
        ('paddle', 'sent-old', 'buyer_receipt', 1, 'sent', now() - interval '2 hours');
    `);
    const stuck = await listStuckDeliveryClaims(GLOBAL.delivery.stuck_claim_after_seconds * 1000);
    expect(stuck.map((s) => [s.provider, s.saleId, s.sendKind, s.fence])).toEqual([["paddle", "stuck-1", "buyer_receipt", 1]]);
    expect(Number.isNaN(Date.parse(stuck[0].claimedAt))).toBe(false);
  });
});
