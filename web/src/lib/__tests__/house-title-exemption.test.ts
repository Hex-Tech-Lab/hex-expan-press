// House title exemption (founder decision, 2026-11-19), run against the real migrations in an in-process Postgres (pglite).
// A house product (creators.is_house) launches without creator consents C1-C3, but only while its release hash equals the
// pinned digest in house_release_pins. Creator products keep the consent gate. Only the operator can set is_house.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../supabase/migrations", name), "utf8");
const MIGRATIONS = [
  "20261009000000_launch_trigger_and_audit.sql",
  "20261011000000_launch_gate_rechecks_live_changes.sql",
  "20261116142329_consents_supersedes_set.sql",
  "20261119130000_house_title_exemption.sql",
].map(migration);

// Stand-ins for the tables the migrations depend on. The client roles mirror Supabase's anon/authenticated/service_role.
const SCHEMA = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create type public.consent_kind as enum ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split');
  create table public.creators (id uuid primary key, handle text not null unique, display_name text not null);
  create table public.products (
    id uuid primary key, creator_id uuid, release_sha256 text,
    checkout_mode text check (checkout_mode in ('gated','live','sandbox','paddle'))
  );
  create table public.consents (
    id uuid primary key, kind public.consent_kind not null, product_id uuid, creator_id uuid,
    decision text not null, document_sha256 text, supersedes uuid
  );
`;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOUSE = u(1); // ExpanPress, operator-flagged house creator
const CREATOR = u(2); // an ordinary creator
const PH = u(10); // house product
const PC = u(20); // creator product
const SHA = "c".repeat(64); // the release digest the operator pinned
const OTHER = "d".repeat(64);
const ZERO = "0".repeat(64);
const HOUSE_BLOCKED = /house release hash does not match the pinned release file/;
const CONSENTS_BLOCKED = /required consents \(C1\/C2\/C3\) are not all active/;

let db: PGlite;

async function reset(): Promise<void> {
  // audit_launch_events is append-only; the fixture reset disables its guards, superuser-only, as in production.
  await db.exec(`
    alter table public.audit_launch_events disable trigger user;
    truncate public.audit_launch_events;
    alter table public.audit_launch_events enable trigger user;
    delete from public.house_release_pins;
    delete from public.consents;
    delete from public.products;
    delete from public.creators;
  `);
  await db.query("insert into public.creators (id, handle, display_name, is_house) values ($1, 'expanpress_house', 'ExpanPress', true)", [HOUSE]);
  await db.query("insert into public.creators (id, handle, display_name) values ($1, 'creator_c', 'Creator C')", [CREATOR]);
  await db.query("insert into public.products (id, creator_id, release_sha256, checkout_mode) values ($1, $2, $3, 'gated')", [PH, HOUSE, SHA]);
  await db.query("insert into public.products (id, creator_id, release_sha256, checkout_mode) values ($1, $2, $3, 'gated')", [PC, CREATOR, SHA]);
  await db.query("insert into public.house_release_pins (product_id, sha256) values ($1, $2)", [PH, SHA]);
}

async function giveAllConsents(creator: string, product: string, c2Sha: string): Promise<void> {
  const rows: Array<[string, string, string]> = [
    ["C1_data_accuracy", "given", ""],
    ["C2_release_approval", "given", c2Sha],
    ["C3_revenue_split", "given", ""],
  ];
  for (const [i, [kind, decision, doc]] of rows.entries()) {
    await db.query(
      "insert into public.consents (id, kind, product_id, creator_id, decision, document_sha256) values ($1, $2, $3, $4, $5, $6)",
      [u(500 + i + (product === PC ? 10 : 0)), kind, product, creator, decision, doc || null],
    );
  }
}

const goLive = (product: string) => db.query("update public.products set checkout_mode = 'live' where id = $1", [product]);
const auditCount = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.audit_launch_events")).rows[0].n;
const consentCount = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.consents")).rows[0].n;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  for (const m of MIGRATIONS) await db.exec(m);
}, 30_000);

describe("house title launch: consents skipped, pinned release required", () => {
  beforeEach(reset);

  it("a house product launches with no creator consents when its release matches the pin, and the audit row is written", async () => {
    expect(await consentCount()).toBe(0);
    await expect(goLive(PH)).resolves.toBeDefined();
    expect(await auditCount()).toBe(1);
  });

  it("a house product ignores a refused creator consent, since house titles have no creator consents to refuse", async () => {
    await db.query(
      "insert into public.consents (id, kind, product_id, creator_id, decision, document_sha256) values ($1, 'C1_data_accuracy', $2, $3, 'refused', null)",
      [u(600), PH, HOUSE],
    );
    await expect(goLive(PH)).resolves.toBeDefined();
    expect(await auditCount()).toBe(1);
  });

  it("a house product whose release differs from the pin is blocked", async () => {
    await db.query("update public.products set release_sha256 = $2 where id = $1", [PH, OTHER]);
    await expect(goLive(PH)).rejects.toThrow(HOUSE_BLOCKED);
    expect(await auditCount()).toBe(0);
  });

  it("a house product with no pin row is blocked, never launched on its release hash alone", async () => {
    await db.query("delete from public.house_release_pins where product_id = $1", [PH]);
    await expect(goLive(PH)).rejects.toThrow(HOUSE_BLOCKED);
    expect(await auditCount()).toBe(0);
  });

  it("a house product with an invalid release hash is blocked by the existing validity rule", async () => {
    await db.query("update public.products set release_sha256 = $2 where id = $1", [PH, ZERO]);
    await expect(goLive(PH)).rejects.toThrow(/product has no valid release_sha256/);
  });

  it("a live house product re-checks the pin when its release hash changes", async () => {
    await goLive(PH);
    await expect(db.query("update public.products set release_sha256 = $2 where id = $1", [PH, OTHER])).rejects.toThrow(HOUSE_BLOCKED);
    expect(await auditCount()).toBe(1);
  });

  it("a creator product with no consents is still blocked (the exemption does not leak to creators)", async () => {
    await expect(goLive(PC)).rejects.toThrow(CONSENTS_BLOCKED);
    expect(await auditCount()).toBe(0);
  });

  it("a creator product with all three consents and a matching C2 launches (unchanged path)", async () => {
    await giveAllConsents(CREATOR, PC, SHA);
    await expect(goLive(PC)).resolves.toBeDefined();
    expect(await auditCount()).toBe(1);
  });

  it("a creator product whose C2 approved a different release is still blocked", async () => {
    await giveAllConsents(CREATOR, PC, OTHER);
    await expect(goLive(PC)).rejects.toThrow(/release hash mismatch: C2 approved a different release/);
  });
});

describe("house title grants: only the operator sets is_house, and the pin table is server-read only", () => {
  beforeEach(reset);

  it("a client role cannot set is_house when it holds no UPDATE grant on creators", async () => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("update public.creators set is_house = true where id = $1", [CREATOR])).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
    const { rows } = await db.query<{ is_house: boolean }>("select is_house from public.creators where id = $1", [CREATOR]);
    expect(rows[0].is_house).toBe(false);
  });

  it("a client role is still blocked by the trigger even if a table-level UPDATE grant is ever added", async () => {
    // An UPDATE with a WHERE clause also reads the row, so the worst-case grant includes SELECT.
    await db.exec("grant select, update on public.creators to authenticated");
    try {
      await db.exec("set role authenticated");
      try {
        await expect(db.query("update public.creators set is_house = true where id = $1", [CREATOR])).rejects.toThrow(/set by the operator only/);
      } finally {
        await db.exec("reset role");
      }
    } finally {
      await db.exec("revoke select, update on public.creators from authenticated");
    }
    const { rows } = await db.query<{ is_house: boolean }>("select is_house from public.creators where id = $1", [CREATOR]);
    expect(rows[0].is_house).toBe(false);
  });

  it("a client role cannot create a house creator, but can still create an ordinary creator", async () => {
    await db.exec("grant insert on public.creators to authenticated");
    try {
      await db.exec("set role authenticated");
      try {
        await expect(
          db.query("insert into public.creators (id, handle, display_name, is_house) values ($1, 'fake_house', 'ExpanPress', true)", [u(700)]),
        ).rejects.toThrow(/set by the operator only/);
        await expect(
          db.query("insert into public.creators (id, handle, display_name) values ($1, 'new_creator', 'New Creator')", [u(701)]),
        ).resolves.toBeDefined();
      } finally {
        await db.exec("reset role");
      }
    } finally {
      await db.exec("revoke insert on public.creators from authenticated");
    }
  });

  it("the operator (postgres) can set is_house", async () => {
    await expect(db.query("update public.creators set is_house = true where id = $1", [CREATOR])).resolves.toBeDefined();
    const { rows } = await db.query<{ is_house: boolean }>("select is_house from public.creators where id = $1", [CREATOR]);
    expect(rows[0].is_house).toBe(true);
    await db.query("update public.creators set is_house = false where id = $1", [CREATOR]);
  });

  it("client roles cannot read or write house_release_pins, while service_role can read it", async () => {
    await db.exec("set role authenticated");
    try {
      await expect(db.query("select sha256 from public.house_release_pins")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
    await db.exec("set role anon");
    try {
      await expect(db.query("select sha256 from public.house_release_pins")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    try {
      const { rows } = await db.query<{ sha256: string }>("select sha256 from public.house_release_pins");
      expect(rows).toEqual([{ sha256: SHA }]);
      await expect(db.query("update public.house_release_pins set sha256 = $1", [OTHER])).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
});
