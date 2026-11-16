// Tests the shared identifier rule (ADR 0065) for PRODUCT SLUGS ONLY: the accept/reject cases, the registry values
// for GLOBAL.product_slug, and the product_slug DB CHECK text in migration 20261114130000.
// NOT covered here: the creator handle rule (GLOBAL.handles) and the handle DB CHECK (20261113000000_handle_shape.sql).
// Handle shape is covered by handle_pairwise.test.ts and handle-policy tests, not by this file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL } from "../../../../payments/src/settings_registry";
import { identifierSchema } from "../identifier-rule";

const productSlug = identifierSchema(GLOBAL.product_slug);

describe("product slug rule (registry: product_slug)", () => {
  it.each(["test_quietworkshop", "testquietworkshop", "retirearly500k", "abc", "a_b_c", "test_book_1790377530060"])(
    "accepts %s",
    (ok) => expect(productSlug.safeParse(ok).success).toBe(true),
  );
  it.each(["ab", "test-book-1790377530060", "test__x", "_test", "test_", "Test_Bad", "a".repeat(31), "test.dot"])(
    "rejects %s",
    (bad) => expect(productSlug.safeParse(bad).success).toBe(false),
  );
  it("uses the registry values, not literals", () => {
    expect(GLOBAL.product_slug).toEqual({ min_length: 3, max_length: 30, separator: "_" });
  });
  it("matches the product_slug DB CHECK in the 20261114130000 migration", () => {
    const sql = readFileSync(path.join(__dirname, "../../../../supabase/migrations/20261114130000_products_slug_agreed_rule.sql"), "utf8");
    const { min_length, max_length } = GLOBAL.product_slug;
    expect(sql).toContain(`char_length(slug) between ${min_length} and ${max_length}`);
    expect(sql).toContain("'^[a-z0-9]+(_[a-z0-9]+)*$'");
  });
});
