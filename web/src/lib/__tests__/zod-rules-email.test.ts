// O5: the sign-in email schema. Shape comes from zod's email format; the length ceiling comes from the
// settings registry (GLOBAL.email_address), not a literal.
import { describe, expect, it } from "vitest";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { emailSchema } from "../zod-rules";

const MAX = GLOBAL.email_address.max_length;
const DOMAIN = "@example.com";

describe("emailSchema (sign-in email, registry: email_address)", () => {
  it("accepts a well-formed email", () => {
    expect(emailSchema.safeParse("creator@example.com").success).toBe(true);
  });

  it.each(["not-an-email", "creator@", "@example.com", "two@@example.com"])("rejects %s", (bad) => {
    expect(emailSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts an address exactly at the registry length ceiling", () => {
    const atCeiling = "a".repeat(MAX - DOMAIN.length) + DOMAIN;
    expect(atCeiling).toHaveLength(MAX);
    expect(emailSchema.safeParse(atCeiling).success).toBe(true);
  });

  it("rejects an over-long address one character past the registry ceiling", () => {
    const overLong = "a".repeat(MAX - DOMAIN.length + 1) + DOMAIN;
    expect(overLong).toHaveLength(MAX + 1);
    expect(emailSchema.safeParse(overLong).success).toBe(false);
  });
});
