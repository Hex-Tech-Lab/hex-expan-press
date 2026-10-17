import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const landingSource = readFileSync(
  new URL("../src/components/landing/landing-page.tsx", import.meta.url),
  "utf8",
);

describe("landing revenue-share copy", () => {
  it("ties the revenue share to the creator agreement, not a monthly schedule", () => {
    expect(landingSource).toContain(
      "You receive a share of revenue as set out in your creator agreement.",
    );
    expect(landingSource).not.toMatch(/share of revenue every month/i);
  });
});
