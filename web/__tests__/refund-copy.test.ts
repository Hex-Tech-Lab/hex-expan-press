import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The code revokes download access on a refund (payments/src/sale_access.ts, route /d/[token]), but the public
// copy is not asked to promise it. The copy must not claim a revocation it does not make, and must say refunds
// are decided by the Merchant of Record.
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
