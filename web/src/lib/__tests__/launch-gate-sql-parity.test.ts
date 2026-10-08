// Sprint 17 parity: the products_launch_gate trigger's SQL chain resolver must
// agree with strictActiveConsentKinds / strictChainHead (the checkout route's
// resolver). Runs the real migration in an in-process Postgres (pglite) — no
// network, no keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { strictActiveConsentKinds } from "../consent-chain";

const migration = (name: string) => readFileSync(join(__dirname, "../../../../supabase/migrations", name), "utf8");
// Applied in order: 20261011 replaces the trigger with the live-change re-check.
const MIGRATIONS = ["20261009000000_launch_trigger_and_audit.sql", "20261011000000_launch_gate_rechecks_live_changes.sql"].map(migration);

// Minimal stand-ins for the tables/types the migration depends on.
const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create type public.consent_kind as enum ('C1_data_accuracy', 'C2_release_approval', 'C3_revenue_split');
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
const CREATOR = u(900);
const OTHER_CREATOR = u(901);
const P1 = u(100);
const P2 = u(200);
const SHA = "c".repeat(64);
const KINDS = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];

interface Row {
  id: string;
  kind: string;
  decision: string;
  product_id: string;
  creator_id?: string;
  supersedes: string | null;
  document_sha256?: string | null;
}
const r = (id: number, kind: string, decision: string, product = P1, supersedes: number | null = null, extra: Partial<Row> = {}): Row => ({
  id: u(id),
  kind,
  decision,
  product_id: product,
  supersedes: supersedes === null ? null : u(supersedes),
  document_sha256: kind === "C2_release_approval" ? SHA : null,
  ...extra,
});
const allGiven = (): Row[] => [r(1, KINDS[0], "given"), r(2, KINDS[1], "given"), r(3, KINDS[2], "given")];

const FIXTURES: Record<string, Row[]> = {
  "all given": allGiven(),
  "empty chain": [],
  "C2 missing": [r(1, KINDS[0], "given"), r(3, KINDS[2], "given")],
  "C2 refused": [r(1, KINDS[0], "given"), r(2, KINDS[1], "refused"), r(3, KINDS[2], "given")],
  "C2 superseded by refusal": [...allGiven(), r(4, KINDS[1], "refused", P1, 2)],
  "C2 refusal superseded by given": [r(1, KINDS[0], "given"), r(2, KINDS[1], "refused"), r(4, KINDS[1], "given", P1, 2), r(3, KINDS[2], "given")],
  "two C2 heads (fork)": [...allGiven(), r(4, KINDS[1], "given")],
  "C2 fork given+refused": [...allGiven(), r(4, KINDS[1], "refused")],
  "cross-product supersession": [...allGiven(), r(4, KINDS[1], "given", P2, 2)],
  "cross-kind pointer ignored": [...allGiven(), r(4, KINDS[2], "given", P2, 2)],
  "dangling supersedes pointer": [...allGiven().filter((x) => x.kind !== KINDS[1]), r(2, KINDS[1], "given", P1, 777)],
  "other product only": [r(1, KINDS[0], "given", P2), r(2, KINDS[1], "given", P2), r(3, KINDS[2], "given", P2)],
  "other creator's rows are not in scope": [...allGiven(), r(4, KINDS[1], "refused", P1, 2, { creator_id: OTHER_CREATOR })],
};

let db: PGlite;

async function load(rows: Row[], release: string | null = SHA, mode = "gated") {
  // audit_launch_events is append-only (no truncate/delete), so the fixture
  // reset briefly disables its guards — superuser-only, as in production.
  await db.exec(`
    truncate public.consents;
    alter table public.audit_launch_events disable trigger user;
    truncate public.audit_launch_events;
    alter table public.audit_launch_events enable trigger user;
    delete from public.products;
  `);
  for (const p of [P1, P2]) {
    await db.query("insert into public.products (id, creator_id, release_sha256, checkout_mode) values ($1, $2, $3, $4)", [p, CREATOR, release, mode]);
  }
  for (const x of rows) {
    await db.query(
      "insert into public.consents (id, kind, product_id, creator_id, decision, document_sha256, supersedes) values ($1, $2, $3, $4, $5, $6, $7)",
      [x.id, x.kind, x.product_id, x.creator_id ?? CREATOR, x.decision, x.document_sha256 ?? null, x.supersedes],
    );
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  for (const m of MIGRATIONS) await db.exec(m);
});

describe("SQL strict_active_consent_kinds ≡ TS strictActiveConsentKinds", () => {
  for (const [name, rows] of Object.entries(FIXTURES)) {
    for (const product of [P1, P2]) {
      it(`${name} (${product === P1 ? "P1" : "P2"})`, async () => {
        await load(rows);
        const { rows: sql } = await db.query<{ k: string }>("select public.strict_active_consent_kinds($1, $2) as k", [CREATOR, product]);
        // The route reads the creator's chain only (consents.creator_id = owner).
        const ts = strictActiveConsentKinds(rows.filter((x) => (x.creator_id ?? CREATOR) === CREATOR), product);
        expect(sql.map((x) => x.k).sort()).toEqual([...ts].sort());
      });
    }
  }
});

describe("products_launch_gate trigger", () => {
  const goLive = () => db.query("update public.products set checkout_mode = 'live' where id = $1", [P1]);
  const auditCount = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.audit_launch_events")).rows[0].n;

  beforeEach(async () => {
    await load(allGiven());
  });

  it("allows the transition when consents verify and the C2 hash matches, and writes an audit event", async () => {
    await goLive();
    const { rows } = await db.query<{ product_id: string; release_sha256: string }>("select product_id, release_sha256 from public.audit_launch_events");
    expect(rows).toEqual([{ product_id: P1, release_sha256: SHA }]);
  });

  it("matches the hash case-insensitively", async () => {
    await load(allGiven(), SHA.toUpperCase());
    await goLive();
    expect(await auditCount()).toBe(1);
  });

  it.each([
    ["a mismatched release hash", "d".repeat(64), /release hash mismatch/],
    ["a null release hash", null, /no valid release_sha256/],
    ["an all-zero release hash", "0".repeat(64), /no valid release_sha256/],
  ])("blocks on %s and writes no audit event", async (_label, release, msg) => {
    await load(allGiven(), release);
    await expect(goLive()).rejects.toThrow(msg);
    expect(await auditCount()).toBe(0);
  });

  it("blocks when consents do not verify (C2 superseded by refusal)", async () => {
    await load(FIXTURES["C2 superseded by refusal"]);
    await expect(goLive()).rejects.toThrow(/consents/);
  });

  it("blocks when the C2 head (not a superseded row) carries a different hash", async () => {
    await load([...allGiven(), r(4, KINDS[1], "given", P1, 2, { document_sha256: "e".repeat(64) })]);
    await expect(goLive()).rejects.toThrow(/release hash mismatch/);
  });

  it("blocks an INSERT that arrives already live", async () => {
    await expect(
      db.query("insert into public.products (id, creator_id, release_sha256, checkout_mode) values ($1, $2, $3, 'live')", [u(300), CREATOR, SHA]),
    ).rejects.toThrow(/launch blocked/);
  });

  it("does not re-check or re-audit when the product is already live", async () => {
    await goLive();
    await db.query("update public.products set checkout_mode = 'live' where id = $1", [P1]);
    expect(await auditCount()).toBe(1);
  });

  it("leaves non-live transitions alone", async () => {
    await load([]);
    await db.query("update public.products set checkout_mode = 'sandbox' where id = $1", [P1]);
    expect(await auditCount()).toBe(0);
  });

  it("records the effective session role as the launch actor, not the definer", async () => {
    await db.exec("grant select, update on public.products to service_role; set role service_role;");
    try {
      await goLive();
    } finally {
      await db.exec("reset role;");
    }
    const { rows } = await db.query<{ launched_by: string }>("select launched_by from public.audit_launch_events");
    expect(rows[0].launched_by).toMatch(/^service_role \(session /);
  });
});

describe("live-product changes are re-verified (AGY finding 1)", () => {
  const OTHER = "d".repeat(64);
  const auditCount = async () => (await db.query<{ n: number }>("select count(*)::int as n from public.audit_launch_events")).rows[0].n;

  beforeEach(async () => {
    await load(allGiven());
    await db.query("update public.products set checkout_mode = 'live' where id = $1", [P1]);
  });

  it("blocks changing a live product's release hash to one C2 never approved", async () => {
    await expect(db.query("update public.products set release_sha256 = $2 where id = $1", [P1, OTHER])).rejects.toThrow(/release hash mismatch/);
    expect(await auditCount()).toBe(1);
  });

  it("allows a live hash change the C2 head approved, and audits the re-verified release", async () => {
    await db.query("insert into public.consents (id, kind, product_id, creator_id, decision, document_sha256, supersedes) values ($1, 'C2_release_approval', $2, $3, 'given', $4, $5)", [u(4), P1, CREATOR, OTHER, u(2)]);
    await db.query("update public.products set release_sha256 = $2 where id = $1", [P1, OTHER]);
    const { rows } = await db.query<{ release_sha256: string }>("select release_sha256 from public.audit_launch_events order by id");
    expect(rows.map((x) => x.release_sha256)).toEqual([SHA, OTHER]);
  });

  it("blocks moving a live product to a creator without the consent chain", async () => {
    await expect(db.query("update public.products set creator_id = $2 where id = $1", [P1, OTHER_CREATOR])).rejects.toThrow(/consents/);
  });

  it("leaves hash changes on a non-live product alone", async () => {
    await db.query("update public.products set release_sha256 = $2 where id = $1", [P2, OTHER]);
    expect(await auditCount()).toBe(1);
  });
});

describe("audit_launch_events integrity", () => {
  beforeEach(async () => {
    await load(allGiven());
    await db.query("update public.products set checkout_mode = 'live' where id = $1", [P1]);
  });

  it.each(["update public.audit_launch_events set release_sha256 = 'x'", "delete from public.audit_launch_events", "truncate public.audit_launch_events"])(
    "is append-only: %s is blocked",
    async (sql) => {
      await expect(db.exec(sql)).rejects.toThrow(/append-only/);
    },
  );

  it("denies direct inserts to service_role (only the launch trigger writes)", async () => {
    await db.exec("set role service_role;");
    try {
      await expect(
        db.query("insert into public.audit_launch_events (product_id, release_sha256, launched_by) values ($1, $2, 'forged')", [P2, SHA]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role;");
    }
  });
});
