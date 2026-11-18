// Regression for the six deny_client_* policies (PR #136 review, P2). Applies the real migration to an empty
// PGlite database and asserts (1) every deny policy is AS RESTRICTIVE and (2) a PERMISSIVE grant added to one
// of those tables does not bypass the deny. No network, no .env: PGlite runs in-process.
// Lives under scripts/ops/__tests__ because vitest.config.ts includes no supabase/ path; a file there would never run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../supabase/migrations/20261118090100_deny_client_policies_restrictive.sql");
const TABLES = ["audit_launch_events", "audit_log", "creator_terms", "download_events", "system_config", "webhook_conflicts"];

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  // The migration assumes its tables and the Supabase roles already exist; an empty database has neither.
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
  `);
  for (const t of TABLES) {
    await db.exec(`create table public.${t} (id int primary key); alter table public.${t} enable row level security;`);
  }
  await db.exec("grant usage on schema public to anon, authenticated;");
  for (const t of TABLES) await db.exec(`grant select on public.${t} to anon, authenticated;`);
});

afterEach(async () => {
  await db.close();
});

async function policyRows(): Promise<Array<{ tablename: string; policyname: string; permissive: string; cmd: string }>> {
  const r = await db.query<{ tablename: string; policyname: string; permissive: string; cmd: string }>(
    `select tablename, policyname, permissive, cmd from pg_policies
       where schemaname = 'public' and policyname like 'deny\\_client\\_%' order by tablename`,
  );
  return r.rows;
}

/** Row count visible to a client role. A privilege error throws, so a pass here means RLS filtered the rows. */
async function visibleRows(role: "anon" | "authenticated", table: string): Promise<number> {
  await db.exec(`set role ${role}`);
  try {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
    return r.rows[0].n;
  } finally {
    await db.exec("reset role");
  }
}

describe("deny_client_* policies after 20261118090100", () => {
  it("creates all six deny policies as RESTRICTIVE, for all commands", async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
    const rows = await policyRows();
    expect(rows.map((r) => r.tablename)).toEqual([...TABLES].sort());
    for (const r of rows) {
      expect(r.policyname).toBe(`deny_client_${r.tablename}`);
      expect(r.permissive).toBe("RESTRICTIVE");
      expect(r.cmd).toBe("ALL");
    }
  });

  it("is idempotent: a second run leaves the same six RESTRICTIVE policies", async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
    const first = await policyRows();
    await db.exec(readFileSync(MIGRATION, "utf8"));
    expect(await policyRows()).toEqual(first);
  });

  it.each(["anon", "authenticated"] as const)(
    "a PERMISSIVE grant that would expose rows is blocked for %s once the deny is applied",
    async (role) => {
      await db.exec("insert into public.system_config (id) values (1);");
      // Control: the permissive grant alone exposes the row, so a zero below is caused by the deny.
      await db.exec(`create policy allow_${role}_read on public.system_config for select to ${role} using (true);`);
      expect(await visibleRows(role, "system_config")).toBe(1);

      await db.exec(readFileSync(MIGRATION, "utf8"));
      expect(await visibleRows(role, "system_config")).toBe(0);
    },
  );
});
