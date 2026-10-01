import { afterEach, describe, expect, it } from "vitest";
import {
  assertLaunchConsents,
  paddleEnvironment,
  paddleTokenForEnv,
  primaryPaddle,
  stripPaddleBlocks,
  swap,
} from "../bake_checkout";

const DB_ID = "57596c19-c550-4bde-b17a-e87b86d005c5";
const KINDS = ["C1_data_accuracy", "C2_release_approval", "C3_revenue_split"];

const okRes = (rows: unknown) =>
  ({ ok: true, status: 200, json: async () => rows }) as unknown as Response;
const errRes = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
const givenRow = (kind: string, signed_at: string) => ({ kind, decision: "given", signed_at, superseded_by: null });
const refusedRow = (kind: string, signed_at: string) => ({ kind, decision: "refused", signed_at, superseded_by: null });

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "PADDLE_ENVIRONMENT", "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};
const stashEnv = () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("assertLaunchConsents", () => {
  it("passes when all three kinds are given (latest row each)", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    let called = false;
    await assertLaunchConsents(DB_ID, async () => {
      called = true;
      return okRes(KINDS.map((k, i) => givenRow(k, `2026-09-0${i + 1}T00:00:00Z`)));
    });
    expect(called).toBe(true);
  });

  it("throws naming C3 when C3 is missing", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async () => okRes([givenRow("C1_data_accuracy", "2026-09-01T00:00:00Z"), givenRow("C2_release_approval", "2026-09-02T00:00:00Z")]),
      ),
    ).rejects.toThrow(/C3_revenue_split/);
  });

  it("throws when the most recent C1 row is refused even if an older one is given", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(
        DB_ID,
        async () =>
          okRes([
            // rows arrive ordered signed_at.desc — newest first
            refusedRow("C1_data_accuracy", "2026-09-05T00:00:00Z"),
            givenRow("C1_data_accuracy", "2026-09-01T00:00:00Z"),
            givenRow("C2_release_approval", "2026-09-02T00:00:00Z"),
            givenRow("C3_revenue_split", "2026-09-03T00:00:00Z"),
          ]),
      ),
    ).rejects.toThrow(/C1_data_accuracy/);
  });

  it("throws on HTTP 500", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(assertLaunchConsents(DB_ID, async () => errRes(500))).rejects.toThrow(/HTTP 500/);
  });

  it("throws on network error", async () => {
    stashEnv();
    process.env.SUPABASE_URL = "https://sup.example";
    process.env.SUPABASE_SECRET_KEY = "sk";
    await expect(
      assertLaunchConsents(DB_ID, async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws when env vars are missing", async () => {
    stashEnv();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    await expect(assertLaunchConsents(DB_ID, async () => okRes([]))).rejects.toThrow(/launch blocked/);
  });
});

const paddleBlock = (): string =>
  primaryPaddle("cfg.json", {
    priceId: "pri_abc123",
    clientToken: "live_tok",
    productId: "prod_x",
    environment: "production",
  });

const GATED_SLOT =
  '<a class="buy pending" id="buy" href="#buy-link-pending" data-checkout-slot="primary" data-checkout-mode="gated">Gated</a>';

const stripAndSwapPrimary = (html: string): string =>
  swap(stripPaddleBlocks(html), "primary", GATED_SLOT);

describe("re-bake hygiene (strip markers + swap)", () => {
  it("paddle→paddle replaces the button and leaves exactly one marker block", () => {
    const before = `<html><body>\n${paddleBlock()}\n</body></html>`;
    const after = stripPaddleBlocks(before);
    const rebaked = swap(after, "primary", primaryPaddle("cfg.json", {
      priceId: "pri_new456",
      clientToken: "live_tok2",
      productId: "prod_x",
      environment: "production",
    }));
    expect(rebaked.match(/paddle-checkout:start/g)?.length).toBe(1);
    expect(rebaked.match(/paddle-checkout:end/g)?.length).toBe(1);
    expect(rebaked.match(/data-checkout-mode="paddle"/g)?.length).toBe(1);
    expect(rebaked).toContain("pri_new456");
  });

  it("paddle→gated leaves zero paddle markers/scripts and an <a> gated slot", () => {
    const before = `<html><body>\n${paddleBlock()}\n</body></html>`;
    const after = stripAndSwapPrimary(before);
    expect(after).not.toContain("paddle-checkout");
    expect(after).not.toContain("paddle.js");
    expect(after).not.toContain("<button");
    expect(after).toContain(GATED_SLOT);
  });
});

describe("paddleEnvironment", () => {
  it("accepts sandbox and production", () => {
    expect(paddleEnvironment("sandbox")).toBe("sandbox");
    expect(paddleEnvironment("production")).toBe("production");
  });
  it("throws on unset or typo", () => {
    expect(() => paddleEnvironment(undefined)).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => paddleEnvironment("staging")).toThrow(/PADDLE_ENVIRONMENT/);
    expect(() => paddleEnvironment("")).toThrow(/PADDLE_ENVIRONMENT/);
  });
});

describe("paddleTokenForEnv", () => {
  it("accepts live_ for production and test_ for sandbox", () => {
    expect(paddleTokenForEnv("live_abc", "production")).toBe("live_abc");
    expect(paddleTokenForEnv("test_abc", "sandbox")).toBe("test_abc");
  });
  it("throws on missing token", () => {
    expect(() => paddleTokenForEnv(undefined, "production")).toThrow(/NEXT_PUBLIC_PADDLE_CLIENT_TOKEN/);
  });
  it("throws on prefix disagreement (live_ + sandbox, test_ + production)", () => {
    expect(() => paddleTokenForEnv("live_abc", "sandbox")).toThrow(/live_|prefix/);
    expect(() => paddleTokenForEnv("test_abc", "production")).toThrow(/test_|prefix/);
  });
});
