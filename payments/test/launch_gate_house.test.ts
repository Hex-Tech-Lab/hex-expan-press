// House title exemption at the operator launch gate (founder decision, 2026-11-19). Mirrors launch_block_reason in
// supabase/migrations/20261119130000_house_title_exemption.sql: a house creator skips C1-C3 and must match the pinned release digest.
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertLaunchConsents } from "../src/launch_gate.ts";

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);
const HOUSE_CREATOR = "cr-house";
const CREATOR = "cr-creator";

const env = () => {
  vi.stubEnv("SUPABASE_URL", "https://db.invalid");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
};
afterEach(() => vi.unstubAllEnvs());

// PostgREST-shaped 200: Content-Range carries the exact total (Prefer: count=exact).
const ok = (body: unknown) => {
  const n = Array.isArray(body) ? body.length : 0;
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-range": n ? `0-${n - 1}/${n}` : "*/0" } });
};

// Routes each PostgREST lookup by its table name and records every URL the gate asked for.
function routed(routes: Record<string, unknown>, asked: string[]): typeof fetch {
  return (async (url: string) => {
    const target = String(url);
    asked.push(target);
    const table = Object.keys(routes).find((t) => target.includes(`/rest/v1/${t}?`));
    if (!table) throw new Error(`unexpected lookup ${target}`);
    return ok(routes[table]);
  }) as unknown as typeof fetch;
}

const product = (creator: string, release: string | null) => [{ id: "p1", creator_id: creator, release_sha256: release }];

describe("house title launch gate: consents skipped, pinned release required", () => {
  it("a house creator launches with no consents when the release matches its pin, and never reads consents", async () => {
    env();
    const asked: string[] = [];
    await expect(
      assertLaunchConsents(
        "p1",
        routed({ products: product(HOUSE_CREATOR, SHA), creators: [{ is_house: true }], house_release_pins: [{ sha256: SHA }], consents: [] }, asked),
      ),
    ).resolves.toBeUndefined();
    expect(asked.some((u) => u.includes("/rest/v1/consents?"))).toBe(false);
    expect(asked.some((u) => u.includes("/rest/v1/house_release_pins?product_id=eq.p1"))).toBe(true);
  });

  it("a house creator whose release differs from the pin is blocked", async () => {
    env();
    await expect(
      assertLaunchConsents(
        "p1",
        routed({ products: product(HOUSE_CREATOR, OTHER), creators: [{ is_house: true }], house_release_pins: [{ sha256: SHA }], consents: [] }, []),
      ),
    ).rejects.toThrow(/launch blocked: p1: house release hash does not match the pinned release file \(pinned a{64}, current b{64}\)/);
  });

  it("a house creator with no pin row is blocked, never launched on its release hash alone", async () => {
    env();
    await expect(
      assertLaunchConsents("p1", routed({ products: product(HOUSE_CREATOR, SHA), creators: [{ is_house: true }], house_release_pins: [], consents: [] }, [])),
    ).rejects.toThrow(/house release hash does not match the pinned release file \(pinned none/);
  });

  it("a house creator with an invalid release hash is blocked by the existing validity rule", async () => {
    env();
    await expect(
      assertLaunchConsents("p1", routed({ products: product(HOUSE_CREATOR, "0".repeat(64)), creators: [{ is_house: true }], house_release_pins: [{ sha256: SHA }] }, [])),
    ).rejects.toThrow(/product has no valid release_sha256/);
  });
});

describe("creator launch gate keeps the consent requirement (the exemption does not leak)", () => {
  it("a creator with no consents is still blocked, and the pin table is never read", async () => {
    env();
    const asked: string[] = [];
    await expect(
      assertLaunchConsents("p1", routed({ products: product(CREATOR, SHA), creators: [{ is_house: false }], consents: [] }, asked)),
    ).rejects.toThrow(/missing consent\(s\): C1_data_accuracy, C2_release_approval, C3_revenue_split/);
    expect(asked.some((u) => u.includes("/rest/v1/house_release_pins?"))).toBe(false);
  });

  it("a product whose creator row is absent takes the creator path, so the house exemption cannot be reached by omission", async () => {
    env();
    await expect(
      assertLaunchConsents("p1", routed({ products: product(CREATOR, SHA), creators: [], consents: [] }, [])),
    ).rejects.toThrow(/missing consent\(s\)/);
  });
});
