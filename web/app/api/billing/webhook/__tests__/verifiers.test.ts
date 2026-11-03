import { describe, it, expect, vi } from "vitest";

// Use the inline defaults, not a local data/settings/providers.json, so the expected set is fixed on every machine.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => false };
});

import { routableVerifiers } from "../verifiers";

// Pins the real switch through the route's verifier list (not a mocked switch): with the inline defaults,
// Paddle and Fungies are offered requests and Polar is not.
describe("webhook verifier list follows the launch switch", () => {
  it("offers Paddle and Fungies, and not switched-off Polar", () => {
    expect(routableVerifiers().map((a) => a.providerName)).toEqual(["paddle", "fungies"]);
  });
});
