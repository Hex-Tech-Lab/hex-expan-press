import { readdirSync, readFileSync } from "node:fs";
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
  // Take the pattern from the latest migration that declares the creators.handle CHECK, so a later
  // migration that changes the rule is caught here rather than hidden by the creation migration.
  const migrationsDir = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
  const declaration = /handle\s+text\s+not null unique check \(handle ~ '([^']+)'\)/i;

  it("HANDLE_RE is exactly the latest creators.handle CHECK pattern", () => {
    let latest: string | undefined;
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      const match = declaration.exec(readFileSync(migrationsDir + file, "utf8"));
      if (match) latest = match[1];
    }
    expect(latest, "creators.handle CHECK not found").toBeDefined();
    expect(latest).toBe(HANDLE_RE.source);
  });
});
