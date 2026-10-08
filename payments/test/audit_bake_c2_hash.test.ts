// AUDIT 2026-10-02 (F6): the launch gate accepts a C2 approval bound to a
// release PDF hash that is no longer products.release_sha256.
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertLaunchConsents } from "../src/launch_gate.ts";

const OLD = "a".repeat(64), CURRENT = "b".repeat(64);
const ZERO = "0".repeat(64);
const row = (id: string, kind: string, sha: string | null) =>
  ({ id, kind, decision: "given", product_id: "p1", signed_at: "2026-10-01T00:00:00Z", supersedes: null, document_sha256: sha });

const env = () => {
  vi.stubEnv("SUPABASE_URL", "https://db.invalid");
  vi.stubEnv("SUPABASE_SECRET_KEY", "test");
};
afterEach(() => vi.unstubAllEnvs());

const fullRows = (c2Sha: string | null) => [
  row("1", "C1_data_accuracy", null),
  row("2", "C2_release_approval", c2Sha),
  row("3", "C3_revenue_split", null),
];

const fetchFor = (
  productsBody: unknown,
  consentsBody: unknown = fullRows(OLD),
) =>
  (async (url: string) => {
    const body = String(url).includes("/products") ? productsBody : consentsBody;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

describe("F6 launch gate vs rebuilt release PDF", () => {
  it("blocks launch when the C2 head approved an older release hash", async () => {
    env();
    await expect(assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: CURRENT, creator_id: "cr1" }]))).rejects.toThrow(
      /launch blocked: p1: C2 approved a different release \(approved a{64}, current b{64}\)/,
    );
  });

  it("allows launch when the approved hash matches the current release", async () => {
    env();
    await expect(assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: CURRENT, creator_id: "cr1" }], fullRows(CURRENT)))).resolves.toBeUndefined();
  });

  it("allows uppercase/lowercase hash mismatch to pass (case-insensitive match)", async () => {
    env();
    const upper = (s: string) => s.toUpperCase();
    await expect(
      assertLaunchConsents(
        "p1",
        fetchFor([{ id: "p1", release_sha256: upper(CURRENT), creator_id: "cr1" }], fullRows(upper(CURRENT))),
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks when the product row is missing (empty products response)", async () => {
    env();
    await expect(assertLaunchConsents("p1", fetchFor([], fullRows(CURRENT)))).rejects.toThrow(/launch blocked/);
  });

  it("blocks when the product release_sha256 is all zeros", async () => {
    env();
    await expect(assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: ZERO }], fullRows(CURRENT)))).rejects.toThrow(
      /launch blocked/,
    );
  });

  it("blocks when the product release_sha256 is blank", async () => {
    env();
    await expect(assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: "  " }], fullRows(CURRENT)))).rejects.toThrow(
      /launch blocked/,
    );
  });

  it("blocks when the product release_sha256 is not 64-hex", async () => {
    env();
    await expect(assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: "deadbeef" }], fullRows(CURRENT)))).rejects.toThrow(
      /launch blocked/,
    );
  });

  it("blocks when the C2 head document_sha256 is missing/zero", async () => {
    env();
    await expect(assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: CURRENT, creator_id: "cr1" }], fullRows(null)))).rejects.toThrow(
      /launch blocked/,
    );
    await expect(assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: CURRENT, creator_id: "cr1" }], fullRows(ZERO)))).rejects.toThrow(
      /launch blocked/,
    );
  });

  it("blocks when the products fetch fails (fetch error)", async () => {
    env();
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/products")) throw new Error("ECONNRESET");
      return new Response(JSON.stringify(fullRows(CURRENT)), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(assertLaunchConsents("p1", fetchImpl)).rejects.toThrow(/launch blocked.*release lookup failed/);
  });

  it("blocks when the products fetch returns a non-200 status", async () => {
    env();
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/products")) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify(fullRows(CURRENT)), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(assertLaunchConsents("p1", fetchImpl)).rejects.toThrow(/launch blocked.*HTTP 500/);
  });

  it("blocks when the products fetch returns an unparseable body", async () => {
    env();
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/products"))
        return new Response("<html>gateway</html>", { status: 200 });
      return new Response(JSON.stringify(fullRows(CURRENT)), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(assertLaunchConsents("p1", fetchImpl)).rejects.toThrow(/launch blocked.*unparseable/);
  });
});

describe("F6 launch gate vs a PostgREST-faithful select projection", () => {
  // PostgREST returns only the columns named in `select`; a mock that ignores it hid
  // a gate that could never pass (document_sha256 was never requested).
  const project = (url: string, body: unknown) => {
    const cols = new URL(url).searchParams.get("select")?.split(",");
    if (!cols || !Array.isArray(body)) return body;
    return body.map((r: Record<string, unknown>) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
  };
  const projectingFetch = (productsBody: unknown, consentsBody: unknown) =>
    (async (url: string) => {
      const body = String(url).includes("/products") ? productsBody : consentsBody;
      return new Response(JSON.stringify(project(String(url), body)), { status: 200 });
    }) as unknown as typeof fetch;

  it("allows launch when C2 matches the current release, with select honoured", async () => {
    env();
    await expect(
      assertLaunchConsents("p1", projectingFetch([{ id: "p1", release_sha256: CURRENT, creator_id: "cr1" }], fullRows(CURRENT))),
    ).resolves.toBeUndefined();
  });

  it("requests a deterministic consents ordering (signed_at desc, id desc)", async () => {
    env();
    let seenOrder: string | null = null;
    const orderProbeFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/products")) return new Response(JSON.stringify([{ id: "p1", release_sha256: CURRENT, creator_id: "cr1" }]), { status: 200 });
      seenOrder = new URL(u).searchParams.get("order");
      return new Response(JSON.stringify(project(u, fullRows(CURRENT))), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(assertLaunchConsents("p1", orderProbeFetch)).resolves.toBeUndefined();
    expect(seenOrder).toBe("signed_at.desc,id.desc");
  });
});

describe("Sprint 17 parity: creator-wide supersession (matches the checkout route)", () => {
  const PRODUCT = [{ id: "p1", release_sha256: CURRENT, creator_id: "cr1" }];

  it("blocks when the product's C2 was superseded by a same-kind row on ANOTHER product", async () => {
    env();
    const rows = [
      ...fullRows(CURRENT),
      { ...row("9", "C2_release_approval", CURRENT), product_id: "p2", supersedes: "2" },
    ];
    await expect(assertLaunchConsents("p1", fetchFor(PRODUCT, rows))).rejects.toThrow(/missing consent\(s\): C2_release_approval/);
  });

  it("ignores a cross-KIND supersedes pointer (it never supersedes)", async () => {
    env();
    const rows = [...fullRows(CURRENT), { ...row("9", "C3_revenue_split", null), product_id: "p2", supersedes: "2" }];
    await expect(assertLaunchConsents("p1", fetchFor(PRODUCT, rows))).resolves.toBeUndefined();
  });

  it("blocks when the product has no owner", async () => {
    env();
    await expect(
      assertLaunchConsents("p1", fetchFor([{ id: "p1", release_sha256: CURRENT }], fullRows(CURRENT))),
    ).rejects.toThrow(/no owner/);
  });

  it("scopes the consent query to the product owner", async () => {
    env();
    let consentsUrl = "";
    const probe = (async (url: string) => {
      const u = String(url);
      if (u.includes("/products")) return new Response(JSON.stringify(PRODUCT), { status: 200 });
      consentsUrl = u;
      return new Response(JSON.stringify(fullRows(CURRENT)), { status: 200 });
    }) as unknown as typeof fetch;
    await assertLaunchConsents("p1", probe);
    expect(new URL(consentsUrl).searchParams.get("creator_id")).toBe("eq.cr1");
  });
});
