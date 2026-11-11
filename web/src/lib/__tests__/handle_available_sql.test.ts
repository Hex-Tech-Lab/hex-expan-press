import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Contract for public.handle_available, read from the migrations as text. No database is touched.
// The definition under test is the latest `create [or replace] function` in the migrations.
// Grants are read from every migration: `create or replace` keeps the existing ACL, so the grant
// lives in the creation migration and the strict migration does not repeat it.

const migrationsDir = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));

// Drop SQL line comments so a commented-out line cannot satisfy an assertion.
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

const sources = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: stripComments(readFileSync(migrationsDir + file, "utf8")) }));

// head: the header up to `as $$`. body: the text between `$$` and `$$;`.
const definitionPattern =
  /(create\s+(?:or\s+replace\s+)?function\s+public\.handle_available\s*\([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$\s*;/gi;

const definitions: { file: string; head: string; body: string }[] = [];
for (const { file, sql } of sources) {
  definitionPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = definitionPattern.exec(sql)) !== null) {
    definitions.push({ file, head: match[1], body: match[2] });
  }
}

// Migration filenames sort by timestamp, so the last definition is the latest.
const latest = definitions[definitions.length - 1] ?? { file: "", head: "", body: "" };

const filesMatching = (pattern: RegExp) =>
  sources.filter(({ sql }) => pattern.test(sql)).map(({ file }) => file);

describe("public.handle_available: latest definition", () => {
  it("has at least one definition in the migrations", () => {
    expect(definitions.length).toBeGreaterThan(0);
  });

  it("the latest definition is the hardened migration, not the creation or strict migration", () => {
    expect(latest.file).toBe("20261111110141_handle_available_hardened.sql");
  });

  it("returns boolean", () => {
    expect(latest.head).toMatch(/^\s*returns\s+boolean\s*$/im);
  });

  it("is strict, so a NULL argument returns NULL", () => {
    expect(latest.head).toMatch(/^\s*strict\s*$/im);
  });

  it("is security definer", () => {
    expect(latest.head).toMatch(/^\s*security\s+definer\s*$/im);
  });

  it("pins search_path to the empty string, so no name resolves through the caller's path", () => {
    expect(latest.head).toMatch(/^\s*set\s+search_path\s*=\s*''\s*$/im);
  });

  it("reads only public.creators", () => {
    const tables = (latest.body.match(/\b(?:from|join)\s+[\w.]+/gi) ?? []).map((s) =>
      s.split(/\s+/)[1].toLowerCase(),
    );
    expect(tables).toEqual(["public.creators"]);
  });

  it("uses only the creators.handle column", () => {
    const columns = Array.from(new Set((latest.body.match(/\bc\.\w+/g) ?? []).map((s) => s.slice(2))));
    expect(columns).toEqual(["handle"]);
  });

  it("compares c.handle = pg_catalog.lower(p_handle)", () => {
    expect(latest.body).toMatch(/\bc\.handle\s*=\s*pg_catalog\.lower\s*\(\s*p_handle\s*\)/i);
  });

  it("calls no unqualified function, so lower() cannot resolve through search_path", () => {
    expect(latest.body).not.toMatch(/(?<!pg_catalog\.)\blower\s*\(/i);
  });
});

describe("public.handle_available: grants", () => {
  it("revokes EXECUTE from public", () => {
    expect(
      filesMatching(/^\s*revoke\s+execute\s+on\s+function\s+public\.handle_available\s*\(\s*text\s*\)\s+from\s+public\s*;/im),
    ).not.toEqual([]);
  });

  it("grants EXECUTE to anon and authenticated", () => {
    expect(
      filesMatching(/^\s*grant\s+execute\s+on\s+function\s+public\.handle_available\s*\(\s*text\s*\)\s+to\s+anon\s*,\s*authenticated\s*;/im),
    ).not.toEqual([]);
  });

  it("no migration drops the function, which would reset its grants", () => {
    expect(filesMatching(/\bdrop\s+function\b[^;]*\bpublic\.handle_available\b/i)).toEqual([]);
  });
});
