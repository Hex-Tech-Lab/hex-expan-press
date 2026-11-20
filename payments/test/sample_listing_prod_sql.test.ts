// Validates supabase/manual/sample_listing_prod.sql in-process against real schema constraints
// and migrations (PGlite): single transaction, idempotent re-execution, operator-only is_house
// guard, release_sha256 + house_release_pins parity, and launch_block_reason(...) = NULL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = join(__dirname, "../..");
const migration = (name: string) => readFileSync(join(rootDir, "supabase/migrations", name), "utf8");
const MANUAL_SQL = readFileSync(join(rootDir, "supabase/manual/sample_listing_prod.sql"), "utf8");

const MIGRATIONS = [
  "20261009000000_launch_trigger_and_audit.sql",
  "20261011000000_launch_gate_rechecks_live_changes.sql",
  "20261103134245_products_release_lifecycle.sql",
  "20261112231010_handle_shape.sql",
  "20261116142329_consents_supersedes_set.sql",
  "20261117110000_products_slug_convergence.sql",
  "20261119130000_house_title_exemption.sql",
].map(migration);

const BASE_SCHEMA = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create type public.consent_kind as enum ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split');
  create table public.creators (
    id uuid primary key default gen_random_uuid(),
    handle text not null unique check (handle ~ '^[a-z0-9_-]{2,64}$'),
    display_name text not null,
    created_at timestamptz not null default now()
  );
  create table public.products (
    id uuid primary key default gen_random_uuid(),
    creator_id uuid not null references public.creators(id) on delete restrict,
    slug text not null check (slug ~ '^[a-z0-9-]{2,80}$'),
    title text not null,
    description text,
    price_usd numeric(10,2) check (price_usd is null or price_usd > 0),
    currency text not null default 'USD',
    store_product_id text unique,
    pdf_file text,
    release_path text,
    release_sha256 text check (release_sha256 ~ '^[0-9a-f]{64}$'),
    checkout_mode text check (checkout_mode in ('gated','live','sandbox','paddle')),
    book_registry text,
    created_at timestamptz not null default now(),
    unique (creator_id, slug)
  );
  create table public.consents (
    id uuid primary key default gen_random_uuid(),
    kind public.consent_kind not null,
    product_id uuid not null references public.products(id) on delete restrict,
    creator_id uuid not null references public.creators(id) on delete restrict,
    decision text not null check (decision in ('given', 'refused')),
    document_sha256 text,
    supersedes uuid references public.consents(id),
    supersedes_ids uuid[] not null default '{}',
    signed_at timestamptz not null default now()
  );
`;

const EXPECTED_SHA = "74751711467a13e89b98d10a4e5e490d82fc11c2463f37f5d77f4ab320b635d9";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  for (const m of MIGRATIONS) {
    await db.exec(m);
  }
}, 30_000);

describe("supabase/manual/sample_listing_prod.sql", () => {
  it("runs inside one transaction, is idempotent across repeated runs, and satisfies launch_block_reason = NULL", async () => {
    expect(MANUAL_SQL).toMatch(/^\s*begin;/im);
    expect(MANUAL_SQL).toMatch(/^\s*commit;/im);

    // First execution (clean DB)
    const firstResults = await db.exec(MANUAL_SQL);
    const firstSelect = firstResults.at(-2)?.rows as Array<Record<string, unknown>>;
    const firstGate = firstResults.at(-1)?.rows as Array<{ product_id: string; launch_block_reason: string | null }>;

    expect(firstSelect).toHaveLength(1);
    expect(firstSelect[0]).toMatchObject({
      creator_handle: "expanpress_house",
      creator_display_name: "ExpanPress",
      is_house: true,
      slug: "sample_the_quiet_workshop",
      title: "The Quiet Workshop (Sample)",
      currency: "USD",
      store_product_id: "house_sample_the_quiet_workshop_v1",
      pdf_file: "ExpanPress_Sample_TheQuietWorkshop_EliasHartwell_2026.pdf",
      checkout_mode: "gated",
      book_registry: "books/sample_the_quiet_workshop.json",
      release_state: "release",
      release_year: 2026,
      release_path: "release/9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc_release.pdf",
      release_sha256: EXPECTED_SHA,
      pinned_sha256: EXPECTED_SHA,
      hash_matches_pin: true,
    });
    expect(Number(firstSelect[0].price_usd)).toBe(9);
    expect(firstGate).toEqual([
      {
        product_id: "9a3b37eb-3aca-4bb9-b320-bafa3efdfbbc",
        launch_block_reason: null,
      },
    ]);

    // Second execution (idempotency check)
    const secondResults = await db.exec(MANUAL_SQL);
    const secondSelect = secondResults.at(-2)?.rows as Array<Record<string, unknown>>;
    expect(secondSelect).toHaveLength(1);
    expect(secondSelect[0].hash_matches_pin).toBe(true);

    const counts = await db.query<{ creators_n: number; products_n: number; pins_n: number }>(`
      select
        (select count(*)::int from public.creators where handle = 'expanpress_house') as creators_n,
        (select count(*)::int from public.products where slug = 'sample_the_quiet_workshop') as products_n,
        (select count(*)::int from public.house_release_pins) as pins_n
    `);
    expect(counts.rows[0]).toEqual({ creators_n: 1, products_n: 1, pins_n: 1 });
  });

  it("blocks non-operator roles from executing the is_house insert/update path", async () => {
    const txBody = MANUAL_SQL.split(/^\s*begin;/im)[1]?.split(/^\s*commit;/im)[0] ?? "";
    expect(txBody.trim()).not.toBe("");
    await db.exec("grant select, insert, update on public.creators to authenticated");
    try {
      await db.exec("set role authenticated");
      try {
        await db.exec("begin");
        await expect(db.exec(txBody)).rejects.toThrow(/permission denied|set by the operator only/);
      } finally {
        await db.exec("rollback").catch(() => undefined);
        await db.exec("reset role");
      }
    } finally {
      await db.exec("revoke select, insert, update on public.creators from authenticated");
    }
  });
});
