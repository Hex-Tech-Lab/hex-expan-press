import { describe, it, expect } from "vitest";
import { handleSchema, HANDLE_SEPARATOR } from "../handle-shape";

describe("handle shape (one rule: letters and digits, underscore as the only separator)", () => {
  it("uses underscore as the separator, from the registry", () => {
    expect(HANDLE_SEPARATOR).toBe("_");
  });

  it.each(["kelly_test", "retirearly500k", "testcreator2", "tester_1790377528628", "abc", "a_b_c"])(
    "accepts %s",
    (ok) => expect(handleSchema.safeParse(ok).success).toBe(true),
  );

  it.each([
    ["too short", "ab"],
    ["hyphen", "jane-doe"],
    ["dot", "jane.doe"],
    ["leading underscore", "_janedoe"],
    ["trailing underscore", "janedoe_"],
    ["doubled underscore", "jane__doe"],
    ["uppercase (checkHandle lowercases first)", "Jane"],
    ["too long", "a".repeat(31)],
    ["space", "jane doe"],
  ])("rejects %s", (_label, bad) => expect(handleSchema.safeParse(bad).success).toBe(false));
});
