import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The code does not revoke download access on refund or chargeback (backlog: refund revocation). Refund copy
// must therefore not promise that access ends. It must say refunds are decided by the Merchant of Record.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const REVOCATION_CLAIM = /revok|access (ends|will end|is removed|is terminated|stops)|lose (your )?access|no longer (have|hold) access|terminat\w* (your )?access/i;

describe("refund copy matches code", () => {
  it("does not promise that download access is revoked on refund", () => {
    expect(read("public/refund-policy.html")).not.toMatch(REVOCATION_CLAIM);
    expect(read("public/terms.html")).not.toMatch(REVOCATION_CLAIM);
  });

  it("defers refund decisions to the Merchant of Record, as the code routes refunds through it", () => {
    expect(read("public/refund-policy.html")).toMatch(/refunds? (are|is) decided by Paddle\.com/i);
  });
});
