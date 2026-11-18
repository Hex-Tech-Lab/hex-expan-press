// Fixture tests for scripts/ops/stuck_report.ts. No network, no .env: the env and fetch are injected fakes.
import { describe, expect, it } from "vitest";
import {
  collectStuck,
  dedupeReviewRows,
  exitCodeForStuck,
  renderStuck,
  type StuckReport,
  type StuckSettings,
} from "../stuck_report.ts";
import { DEFAULT_GLOBAL } from "../../../payments/src/settings_registry.ts";

const BASE = "https://fixtureref0000000000.supabase.co";
const KEY = "fixture-service-key-not-real";
const ENV = { SUPABASE_URL: BASE, SUPABASE_SECRET_KEY: KEY };
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const S: StuckSettings = {
  stuck_claim_after_seconds: DEFAULT_GLOBAL.delivery.stuck_claim_after_seconds,
  stuck_claim_list_limit: DEFAULT_GLOBAL.delivery.stuck_claim_list_limit,
  review_queue_page_size: DEFAULT_GLOBAL.payments.review_queue_page_size,
  timeout_ms: DEFAULT_GLOBAL.payments.sync_http_timeout_ms,
};

const CLAIM = { provider: "paddle", sale_id: "sale_1", send_kind: "download_link", created_at: "2026-11-18T10:00:00.000Z" };
const REVIEW_A = { details: { provider: "paddle", sale_id: "sale_9" } };
const REVIEW_A_AGAIN = { details: { provider: "paddle", sale_id: "sale_9" } };
const REVIEW_NO_SALE = { details: { provider: "paddle" } };

/** Routes by table name. Records every requested URL so the test can check the query shape. */
function fakeFetch(claims: unknown[], review: unknown[], status = 200) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (status !== 200) return new Response("upstream body must not be echoed", { status });
    const body = url.includes("/rest/v1/delivery_sends") ? claims : url.includes("/rest/v1/audit_log") ? review : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("dedupeReviewRows", () => {
  it("collapses repeat rows for one (provider, sale_id) and keeps incomplete rows standalone", () => {
    const out = dedupeReviewRows([REVIEW_A, REVIEW_A_AGAIN, REVIEW_NO_SALE]);
    expect(out).toEqual([
      { provider: "paddle", saleId: "sale_9", occurrences: 2 },
      { provider: "paddle", saleId: null, occurrences: 1 },
    ]);
  });
});

describe("collectStuck", () => {
  it("counts stuck claims and distinct review items from the fixture rows", async () => {
    const { fetchImpl } = fakeFetch([CLAIM], [REVIEW_A, REVIEW_A_AGAIN]);
    const r = await collectStuck(ENV, fetchImpl, NOW, S);
    expect(r.stuckClaims).toEqual([{ provider: "paddle", saleId: "sale_1", sendKind: "download_link", claimedAt: CLAIM.created_at }]);
    expect(r.reviewItems).toEqual([{ provider: "paddle", saleId: "sale_9", occurrences: 2 }]);
  });

  it("builds the claim cutoff from the registry window, filters state=claimed, and caps at the list limit", async () => {
    const { fetchImpl, urls } = fakeFetch([], []);
    await collectStuck(ENV, fetchImpl, NOW, S);
    const claimUrl = new URL(urls.find((u) => u.includes("/rest/v1/delivery_sends")) as string);
    const cutoff = new Date(NOW - S.stuck_claim_after_seconds * 1000).toISOString();
    expect(claimUrl.searchParams.get("state")).toBe("eq.claimed");
    expect(claimUrl.searchParams.get("created_at")).toBe(`lte.${cutoff}`);
    expect(claimUrl.searchParams.get("limit")).toBe(String(S.stuck_claim_list_limit));
  });

  it("sends the secret only in headers, never in the URL", async () => {
    const seen: Array<{ url: string; headers: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: init?.headers });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    await collectStuck(ENV, fetchImpl, NOW, S);
    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.url).not.toContain(KEY);
      expect(JSON.stringify(s.headers)).toContain(KEY);
    }
  });

  it("throws, without a request, when the config is missing or the URL is not HTTPS", async () => {
    const { fetchImpl, urls } = fakeFetch([], []);
    await expect(collectStuck({}, fetchImpl, NOW, S)).rejects.toThrow(/not set/);
    await expect(collectStuck({ SUPABASE_URL: "http://insecure.example", SUPABASE_SECRET_KEY: KEY }, fetchImpl, NOW, S)).rejects.toThrow(/HTTPS/);
    expect(urls).toEqual([]);
  });

  it("throws on an HTTP error with the status only, so an upstream body is never echoed", async () => {
    const { fetchImpl } = fakeFetch([], [], 500);
    const err = await collectStuck(ENV, fetchImpl, NOW, S).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("stuck delivery claim lookup failed: HTTP 500");
  });
});

describe("exitCodeForStuck and renderStuck", () => {
  const empty: StuckReport = { stuckClaims: [], claimLimit: 500, reviewItems: [], reviewRowsRead: 0, reviewLimit: 200 };

  it("exits 0 only when both lists are empty", () => {
    expect(exitCodeForStuck(empty)).toBe(0);
    expect(renderStuck(empty, 900)).toContain("RESULT: clear (exit 0)");
  });

  it("exits 1 for a stuck claim alone and for a review item alone", () => {
    const claimOnly = { ...empty, stuckClaims: [{ provider: "paddle", saleId: "s", sendKind: "download_link", claimedAt: "x" }] };
    const reviewOnly = { ...empty, reviewItems: [{ provider: "paddle", saleId: "s", occurrences: 1 }] };
    expect(exitCodeForStuck(claimOnly)).toBe(1);
    expect(exitCodeForStuck(reviewOnly)).toBe(1);
    expect(renderStuck(claimOnly, 900)).toContain("Stuck delivery claims (state=claimed, older than 900 s): 1");
  });

  it("marks a count as a lower bound when a list cap is reached", () => {
    const capped = { ...empty, stuckClaims: [{ provider: "p", saleId: "s", sendKind: "k", claimedAt: "x" }], claimLimit: 1 };
    expect(renderStuck(capped, 900)).toContain("at least 1");
  });

  it("never prints the secret key", async () => {
    const { fetchImpl } = fakeFetch([CLAIM], [REVIEW_A]);
    const r = await collectStuck(ENV, fetchImpl, NOW, S);
    expect(renderStuck(r, 900)).not.toContain(KEY);
  });
});
