// Runs the real public.submit_consent body (migration 20261115110000) in-process
// (PGlite) against a stand-in schema. Auth is stubbed as the service role, so the
// service-role branch (creator lookup, signer membership) is what runs.
// Proves: a new row retires EVERY current head of (product, kind) through
// supersedes_ids; supersedes names the newest head; and the SQL strict resolver
// then reads one head. The advisory lock is not exercised here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  join(__dirname, "../../../../supabase/migrations/20261115110000_consents_supersedes_set.sql"),
  "utf8",
);

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create type public.consent_kind as enum ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split');
  create table public.products (id uuid primary key, creator_id uuid, release_sha256 text);
  create table public.creator_users (creator_id uuid not null, user_id uuid not null);
  create table public.audit_log (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    actor uuid, creator_id uuid, event text not null,
    details jsonb not null default '{}'
  );
  create table public.consents (
    id uuid primary key default gen_random_uuid(),
    kind public.consent_kind not null,
    product_id uuid not null,
    creator_id uuid not null,
    decision text not null check (decision in ('given', 'refused')),
    text_version text not null,
    document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
    typed_name text not null check (length(trim(typed_name)) >= 2),
    signed_by uuid not null,
    auth_provider text not null,
    ip inet,
    user_agent text,
    external_ref text,
    evidence_path text,
    supersedes uuid references public.consents(id),
    signed_at timestamptz not null default now()
  );
`;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CREATOR = u(900);
const USER = u(800);
const STRANGER = u(801);
const P = u(100);
const SHA = "c".repeat(64);
const C1 = "C1_data_accuracy";
const C2 = "C2_release_approval";

let db: PGlite;

async function reset() {
  await db.exec(`
    delete from public.consents;
    delete from public.audit_log;
    delete from public.creator_users;
    delete from public.products;
  `);
  await db.query("insert into public.products (id, creator_id, release_sha256) values ($1, $2, $3)", [P, CREATOR, SHA]);
  await db.query("insert into public.creator_users (creator_id, user_id) values ($1, $2)", [CREATOR, USER]);
}

// Seeds a row directly (bypassing submit_consent) so a fork can exist. Explicit
// signed_at keeps the head ordering deterministic.
async function seed(id: number, kind: string, decision: string, signedAt: string, supersedes: number | null = null) {
  await db.query(
    `insert into public.consents (id, kind, product_id, creator_id, decision, text_version, document_sha256, typed_name, signed_by, auth_provider, supersedes, signed_at)
     values ($1, $2, $3, $4, $5, 'v1', $6, 'Jane Doe', $7, 'email', $8, $9)`,
    [u(id), kind, P, CREATOR, decision, SHA, USER, supersedes === null ? null : u(supersedes), signedAt],
  );
}

async function submit(kind: string, decision: string, signer: string = USER, sha: string = SHA) {
  const { rows } = await db.query<{ id: string }>(
    "select public.submit_consent($1::uuid, $2, $3, 'v1', $4, 'Jane Doe', null::inet, 'ua', 'email', null, null, $5::uuid) as id",
    [P, kind, decision, sha, signer],
  );
  return rows[0].id;
}

async function readLink(id: string) {
  const { rows } = await db.query<{ supersedes: string | null; ids: string[] }>(
    "select supersedes::text as supersedes, supersedes_ids::text[] as ids from public.consents where id = $1",
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIGRATION);
}, 30_000);

beforeEach(reset);

describe("submit_consent writes the supersession set", () => {
  it("an empty chain writes no predecessor and an empty set", async () => {
    const id = await submit(C1, "given");
    const link = await readLink(id);
    expect(link.supersedes).toBeNull();
    expect(link.ids).toEqual([]);
  });

  it("a single chain retires its one head through both columns", async () => {
    await seed(1, C1, "given", "2026-01-01T00:00:00Z");
    const id = await submit(C1, "given");
    const link = await readLink(id);
    expect(link.supersedes).toBe(u(1));
    expect(link.ids).toEqual([u(1)]);
  });

  it("a fork: the new row retires EVERY head, and supersedes names the newest", async () => {
    await seed(1, C1, "given", "2026-01-01T00:00:00Z");
    await seed(2, C1, "refused", "2026-01-02T00:00:00Z");
    const id = await submit(C1, "given");
    const link = await readLink(id);
    expect(link.supersedes).toBe(u(2));
    expect([...link.ids].sort()).toEqual([u(1), u(2)].sort());
  });

  it("after a fork is retired, the SQL strict resolver sees one head: the new given row", async () => {
    await seed(1, C1, "given", "2026-01-01T00:00:00Z");
    await seed(2, C1, "refused", "2026-01-02T00:00:00Z");
    const id = await submit(C1, "given");
    const { rows } = await db.query<{ k: string }>("select public.strict_active_consent_kinds($1, $2) as k", [CREATOR, P]);
    expect(rows.map((r) => r.k)).toContain(C1);
    const head = await db.query<{ id: string }>(
      "select id::text as id from public.consents c where c.product_id = $1 and c.kind = $2 and not exists (select 1 from public.consents s where s.kind = c.kind and (s.supersedes = c.id or c.id = any (s.supersedes_ids)))",
      [P, C1],
    );
    expect(head.rows.map((r) => r.id)).toEqual([id]);
  });

  it("a later submit retires the previous single head only (no stale heads carried forward)", async () => {
    await seed(1, C1, "given", "2026-01-01T00:00:00Z");
    await seed(2, C1, "refused", "2026-01-02T00:00:00Z");
    const first = await submit(C1, "given");
    const second = await submit(C1, "refused");
    const link = await readLink(second);
    expect(link.supersedes).toBe(first);
    expect(link.ids).toEqual([first]);
  });

  it("the predecessor set never includes a row of another kind", async () => {
    await seed(1, C2, "given", "2026-01-01T00:00:00Z");
    const id = await submit(C1, "given", USER, SHA);
    const link = await readLink(id);
    expect(link.supersedes).toBeNull();
    expect(link.ids).toEqual([]);
  });
});

describe("submit_consent keeps its existing checks", () => {
  it("rejects a C2 approval whose hash is not the product release", async () => {
    await expect(submit(C2, "given", USER, "d".repeat(64))).rejects.toThrow(/does not match the product release/);
  });

  it("rejects a service-role signer who is not a member of the product's creator", async () => {
    await expect(submit(C1, "given", STRANGER)).rejects.toThrow(/not a member of the product/);
  });

  it("rejects an unknown consent kind", async () => {
    await expect(submit("C9_bogus", "given")).rejects.toThrow(/invalid consent kind/);
  });
});
