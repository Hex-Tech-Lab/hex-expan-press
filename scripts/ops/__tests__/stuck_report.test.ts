// Fixture tests for scripts/ops/stuck_report.ts. No network, no .env: the env and fetch are injected fakes.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectStuck,
  dedupeReviewRows,
  exitCodeForStuck,
  isDirectRun,
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
  terminal_reject_lookback_hours: DEFAULT_GLOBAL.delivery.terminal_reject_lookback_hours,
  terminal_reject_list_limit: DEFAULT_GLOBAL.delivery.terminal_reject_list_limit,
  timeout_ms: DEFAULT_GLOBAL.payments.sync_http_timeout_ms,
};
const MODULE_URL = new URL("../stuck_report.ts", import.meta.url).href;

const CLAIM = { provider: "paddle", sale_id: "sale_1", send_kind: "download_link", created_at: "2026-11-18T10:00:00.000Z" };
const REVIEW_A = { details: { provider: "paddle", sale_id: "sale_9" } };
const REVIEW_A_AGAIN = { details: { provider: "paddle", sale_id: "sale_9" } };
const REVIEW_NO_SALE = { details: { provider: "paddle" } };
const REJECT = {
  created_at: "2026-11-18T11:00:00.000Z",
  details: { provider: "paddle", sale_id: "txn_1", reason: "DeliveryBlockedError", payload_sha256: "fixture-digest" },
};
const REJECT_SWITCHED_OFF = {
  created_at: "2026-11-18T11:15:00.000Z",
  details: { provider: "polar", sale_id: "sale_off_1", reason: "provider_switched_off", payload_sha256: "fixture-digest-2" },
};
const REJECT_BARE = { created_at: "2026-11-18T11:30:00.000Z", details: {} };

/** Routes by table name and event. Records every requested URL so the test can check the query shape.
 *  rejectStatus fails only the terminal-reject read, so a later read's failure can be pinned on its own.
 *  older is what the presence probe (at=lt.) returns. Like PostgREST, every read honours its limit. */
function fakeFetch(claims: unknown[], review: unknown[], status = 200, rejects: unknown[] = [], rejectStatus = 200, older: unknown[] = []) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (status !== 200) return new Response("upstream body must not be echoed", { status });
    const limit = Number(new URL(url).searchParams.get("limit"));
    if (url.includes("event=in.(WEBHOOK_TERMINAL_REJECT,WEBHOOK_PROVIDER_SWITCHED_OFF)")) {
      if (rejectStatus !== 200) return new Response("upstream body must not be echoed", { status: rejectStatus });
      const body = url.includes("at=lt.") ? older : rejects;
      return new Response(JSON.stringify(body.slice(0, limit)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = url.includes("/rest/v1/delivery_sends") ? claims : url.includes("/rest/v1/audit_log") ? review : [];
    return new Response(JSON.stringify(body.slice(0, limit)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** Every read answers 200 with the same body, which is not a list. */
function fetchReturningObject(): typeof fetch {
  return (async () => new Response(JSON.stringify({ message: "not a list" }), { status: 200 })) as typeof fetch;
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
    expect(seen.length).toBe(4);
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

  it("fails, and never reads zero rows, when a 2xx body is not a list", async () => {
    const err = await collectStuck(ENV, fetchReturningObject(), NOW, S).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("stuck delivery claim lookup returned a body that is not a list");
  });

  it("fails when only the terminal-reject read returns a non-list 2xx body", async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("event=in.(WEBHOOK_TERMINAL_REJECT,WEBHOOK_PROVIDER_SWITCHED_OFF)")
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response("[]", { status: 200 })) as typeof fetch;
    const err = await collectStuck(ENV, fetchImpl, NOW, S).catch((e: unknown) => e);
    expect((err as Error).message).toBe("terminal reject read returned a body that is not a list");
  });
});

describe("terminal webhook rejects", () => {
  it("lists WEBHOOK_TERMINAL_REJECT and WEBHOOK_PROVIDER_SWITCHED_OFF rows with provider, sale, reason and time, and exits 1", async () => {
    const { fetchImpl } = fakeFetch([], [], 200, [REJECT, REJECT_SWITCHED_OFF]);
    const r = await collectStuck(ENV, fetchImpl, NOW, S);
    expect(r.terminalRejects).toEqual([
      { provider: "paddle", saleId: "txn_1", reason: "DeliveryBlockedError", at: REJECT.created_at },
      { provider: "polar", saleId: "sale_off_1", reason: "provider_switched_off", at: REJECT_SWITCHED_OFF.created_at },
    ]);
    const out = renderStuck(r, 900);
    expect(out).toContain(
      `Terminal webhook rejects (WEBHOOK_TERMINAL_REJECT, WEBHOOK_PROVIDER_SWITCHED_OFF, last ${S.terminal_reject_lookback_hours} h, newest first): 2`,
    );
    expect(out).toContain("  paddle  sale txn_1  reason DeliveryBlockedError  at 2026-11-18T11:00:00.000Z");
    expect(out).toContain("  polar  sale sale_off_1  reason provider_switched_off  at 2026-11-18T11:15:00.000Z");
    expect(exitCodeForStuck(r)).toBe(1);
  });

  it("queries both terminal-reject and switched-off events with the registry look-back window and list limit", async () => {
    const { fetchImpl, urls } = fakeFetch([], [], 200, []);
    await collectStuck(ENV, fetchImpl, NOW, S);
    const rejectUrl = new URL(urls.find((u) => u.includes("event=in.(WEBHOOK_TERMINAL_REJECT,WEBHOOK_PROVIDER_SWITCHED_OFF)")) as string);
    const since = new Date(NOW - S.terminal_reject_lookback_hours * 3600 * 1000).toISOString();
    expect(rejectUrl.searchParams.get("event")).toBe("in.(WEBHOOK_TERMINAL_REJECT,WEBHOOK_PROVIDER_SWITCHED_OFF)");
    expect(rejectUrl.searchParams.get("at")).toBe(`gte.${since}`);
    expect(rejectUrl.searchParams.get("limit")).toBe(String(S.terminal_reject_list_limit));
    expect(rejectUrl.pathname).toBe("/rest/v1/audit_log");
  });

  it("probes for older rejects with a presence query: before the window, one row, the same events", async () => {
    const { fetchImpl, urls } = fakeFetch([], []);
    await collectStuck(ENV, fetchImpl, NOW, S);
    const probe = new URL(urls.find((u) => u.includes("at=lt.")) as string);
    const since = new Date(NOW - S.terminal_reject_lookback_hours * 3600 * 1000).toISOString();
    expect(probe.pathname).toBe("/rest/v1/audit_log");
    expect(probe.searchParams.get("event")).toBe("in.(WEBHOOK_TERMINAL_REJECT,WEBHOOK_PROVIDER_SWITCHED_OFF)");
    expect(probe.searchParams.get("at")).toBe(`lt.${since}`);
    expect(probe.searchParams.get("limit")).toBe("1");
  });

  it("prints nothing extra for an empty result, and the output is exactly the two existing sections plus the result", async () => {
    const { fetchImpl } = fakeFetch([], [], 200, []);
    const r = await collectStuck(ENV, fetchImpl, NOW, S);
    expect(r.terminalRejects).toEqual([]);
    expect(r.olderRejectsBeyondWindow).toBe(false);
    expect(renderStuck(r, 900)).toBe(
      "Stuck delivery claims (state=claimed, older than 900 s): 0\n" +
        "Manual-review refunds (MANUAL_REVIEW_REQUIRED_REFUND, distinct sale): 0\n" +
        "\n" +
        "RESULT: clear (exit 0)\n",
    );
  });

  it("does not clear over an older reject outside the window: it exits 1 and says so", async () => {
    const { fetchImpl } = fakeFetch([], [], 200, [], 200, [{ id: 7 }]);
    const r = await collectStuck(ENV, fetchImpl, NOW, S);
    expect(r.terminalRejects).toEqual([]);
    expect(r.olderRejectsBeyondWindow).toBe(true);
    expect(exitCodeForStuck(r)).toBe(1);
    const out = renderStuck(r, 900);
    expect(out).toContain(
      `Terminal webhook rejects (WEBHOOK_TERMINAL_REJECT, WEBHOOK_PROVIDER_SWITCHED_OFF, last ${S.terminal_reject_lookback_hours} h, newest first): 0`,
    );
    expect(out).toContain(`at least one older reject exists beyond the last ${S.terminal_reject_lookback_hours} h`);
    expect(out).toContain("not an acknowledgement, so the report stays at exit 1");
    expect(out).toContain("RESULT: action needed");
    expect(out).not.toContain("RESULT: clear");
  });

  it("fails, and never clears, when the older-reject probe read fails", async () => {
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).includes("at=lt.")
        ? new Response("upstream body must not be echoed", { status: 503 })
        : new Response("[]", { status: 200 })) as typeof fetch;
    const err = await collectStuck(ENV, fetchImpl, NOW, S).catch((e: unknown) => e);
    expect((err as Error).message).toBe("older terminal reject probe failed: HTTP 503");
  });

  it("fails loudly, with the status only, when the terminal reject read fails", async () => {
    const { fetchImpl } = fakeFetch([], [], 200, [], 503);
    const err = await collectStuck(ENV, fetchImpl, NOW, S).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("terminal reject read failed: HTTP 503");
    expect((err as Error).message).not.toContain("upstream body must not be echoed");
  });

  it("prints a row with no provider, sale or reason with placeholders, not an empty field", async () => {
    const { fetchImpl } = fakeFetch([], [], 200, [REJECT_BARE]);
    const r = await collectStuck(ENV, fetchImpl, NOW, S);
    expect(r.terminalRejects).toEqual([{ provider: null, saleId: null, reason: null, at: REJECT_BARE.created_at }]);
    expect(renderStuck(r, 900)).toContain("  (no provider)  sale (no sale_id)  reason (no reason)  at 2026-11-18T11:30:00.000Z");
  });

  it("says how many rows are not shown when more than 20 are listed", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      created_at: `2026-11-18T11:${String(i).padStart(2, "0")}:00.000Z`,
      details: { provider: "paddle", sale_id: `txn_${i}`, reason: "DeliveryBlockedError" },
    }));
    const { fetchImpl } = fakeFetch([], [], 200, many);
    const out = renderStuck(await collectStuck(ENV, fetchImpl, NOW, S), 900);
    expect(out).toContain("  ... 1 more not shown");
  });

  it("states the list cap explicitly and exits 1 when the server returns exactly the limit", async () => {
    const small = { ...S, terminal_reject_list_limit: 2 };
    const { fetchImpl } = fakeFetch([], [], 200, [REJECT, REJECT_BARE, REJECT]);
    const r = await collectStuck(ENV, fetchImpl, NOW, small);
    expect(r.terminalRejects).toHaveLength(2);
    const out = renderStuck(r, 900);
    expect(out).toContain("newest first): at least 2");
    expect(out).toContain("list cap reached (limit 2): rows beyond the cap are not listed, so the report stays at exit 1");
    expect(exitCodeForStuck(r)).toBe(1);
    expect(out).not.toContain("RESULT: clear");
  });
});

describe("exitCodeForStuck and renderStuck", () => {
  const empty: StuckReport = {
    stuckClaims: [],
    claimLimit: 500,
    reviewItems: [],
    reviewRowsRead: 0,
    reviewLimit: 200,
    terminalRejects: [],
    terminalRejectLimit: 200,
    terminalRejectLookbackHours: 720,
    olderRejectsBeyondWindow: false,
  };

  it("exits 0 only when all lists are empty and no older reject exists", () => {
    expect(exitCodeForStuck(empty)).toBe(0);
    expect(renderStuck(empty, 900)).toContain("RESULT: clear (exit 0)");
  });

  it("exits 1 for a stuck claim alone, a review item alone, a terminal reject alone, and an older reject alone", () => {
    const claimOnly = { ...empty, stuckClaims: [{ provider: "paddle", saleId: "s", sendKind: "download_link", claimedAt: "x" }] };
    const reviewOnly = { ...empty, reviewItems: [{ provider: "paddle", saleId: "s", occurrences: 1 }] };
    const rejectOnly = { ...empty, terminalRejects: [{ provider: "paddle", saleId: "s", reason: "DeliveryBlockedError", at: "x" }] };
    const olderOnly = { ...empty, olderRejectsBeyondWindow: true };
    expect(exitCodeForStuck(claimOnly)).toBe(1);
    expect(exitCodeForStuck(reviewOnly)).toBe(1);
    expect(exitCodeForStuck(rejectOnly)).toBe(1);
    expect(exitCodeForStuck(olderOnly)).toBe(1);
    expect(renderStuck(claimOnly, 900)).toContain("Stuck delivery claims (state=claimed, older than 900 s): 1");
  });

  it("marks a count as a lower bound when a list cap is reached", () => {
    const capped = { ...empty, stuckClaims: [{ provider: "p", saleId: "s", sendKind: "k", claimedAt: "x" }], claimLimit: 1 };
    expect(renderStuck(capped, 900)).toContain("at least 1");
    const cappedRejects = { ...empty, terminalRejects: [{ provider: "p", saleId: "s", reason: "r", at: "x" }], terminalRejectLimit: 1 };
    expect(renderStuck(cappedRejects, 900)).toContain("newest first): at least 1");
  });

  it("never prints the secret key", async () => {
    const { fetchImpl } = fakeFetch([CLAIM], [REVIEW_A], 200, [REJECT]);
    const r = await collectStuck(ENV, fetchImpl, NOW, S);
    expect(renderStuck(r, 900)).not.toContain(KEY);
  });
});

describe("isDirectRun", () => {
  it("is true for the module itself and for a symlink to it, so a symlinked run still performs the check", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "stuck-report-link-"));
    try {
      const link = path.join(dir, "stuck_report_link.ts");
      symlinkSync(fileURLToPath(MODULE_URL), link);
      expect(isDirectRun(link, MODULE_URL)).toBe(true);
      expect(isDirectRun(fileURLToPath(MODULE_URL), MODULE_URL)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is false when there is no argv entry, a missing path, or another file", () => {
    expect(isDirectRun(undefined, MODULE_URL)).toBe(false);
    expect(isDirectRun(path.join(os.tmpdir(), "stuck-report-not-there.ts"), MODULE_URL)).toBe(false);
    expect(isDirectRun(fileURLToPath(new URL("./stuck_report.test.ts", import.meta.url)), MODULE_URL)).toBe(false);
  });
});
