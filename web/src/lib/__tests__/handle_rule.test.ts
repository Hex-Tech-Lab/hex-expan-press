import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HANDLE_RE, validateHandle } from "../handle_rule";

// The handle rule is the one already in the database (creators.handle). It is not a new rule.

describe("validateHandle", () => {
  it.each(["kelly", "kelly_test", "ab", "a-b_c9", "a".repeat(64)])("accepts %s", (handle) => {
    expect(validateHandle(handle)).toEqual({ ok: true, handle });
  });

  it.each([
    ["", "empty"],
    ["a", "one character"],
    ["a".repeat(65), "65 characters"],
    ["Kelly", "uppercase"],
    ["kelly.b", "period"],
    ["kelly b", "space"],
    ["kellé", "accented letter"],
    ["../admin", "path traversal"],
  ])("rejects %j (%s)", (handle) => {
    expect(validateHandle(handle).ok).toBe(false);
  });
});

describe("parity with the database rule", () => {
  // Read the creator-portal migration and take the pattern from the real creators.handle CHECK.
  const migration = fileURLToPath(
    new URL("../../../../supabase/migrations/20260926000000_creator_portal.sql", import.meta.url),
  );
  const sql = readFileSync(migration, "utf8");

  it("HANDLE_RE is exactly the creators.handle CHECK pattern", () => {
    const match = /handle\s+text\s+not null unique check \(handle ~ '([^']+)'\)/i.exec(sql);
    expect(match, "creators.handle CHECK not found").not.toBeNull();
    expect(match?.[1]).toBe(HANDLE_RE.source);
  });
});
