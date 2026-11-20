// PICT pairwise test for the buyer download link: token state x method x release present x referrer
// (GET logs and 302s on a valid link, HEAD probes without logging, other states return 404, 410 or 500).
// Model: docs/testing/pairwise/download_link.model.txt
// Seed:  docs/testing/pairwise/download_link.seed.tsv pins valid GET with release present, the only row that
//        returns 302 and logs download_completed; PICT does not generate it under the model constraints.
// Rows:  docs/testing/pairwise/download_link.rows.tsv (17 PICT rows: 16 generated + 1 seed)
// Mock harness only: getSupabaseAdmin and the storage signer are stubbed, no network, no production writes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD } from "../app/books/d/[token]/route";

const state = vi.hoisted(() => ({
  link: null as null | Record<string, unknown>,
  product: null as null | Record<string, unknown>,
}));
const insertMock = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const createSignedUrlMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());

type Chain = { select: () => Chain; eq: () => Chain; maybeSingle: () => Promise<unknown> };
function chain(result: () => unknown): Chain {
  const c: Chain = {
    select: () => c,
    eq: () => c,
    maybeSingle: async () => result(),
  };
  return c;
}

const fakeSb = vi.hoisted(() => ({ from: vi.fn(), storage: { from: vi.fn() } }));
vi.mock("../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => fakeSb),
}));

const SIGNED_URL = "https://supabase.example/signed/books/test.pdf";
const VALID_TOKEN = "A".repeat(43);
const UNKNOWN_TOKEN = "B".repeat(43);
const MODEL_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/download_link.model.txt");
const ROWS_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/download_link.rows.tsv");
const SEED_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/download_link.seed.tsv");
const PICT_BIN = "/usr/local/bin/pict";
const EXPECTED_ROW_COUNT = 17;

type TokenState = "valid" | "expired" | "unknown" | "malformed" | "no_expiry";
type Method = "GET" | "HEAD";
type Referrer = "none" | "external" | "same_origin";

interface DownloadRow {
  rowNum: number;
  token_state: TokenState;
  method: Method;
  release_present: "yes" | "no";
  referrer: Referrer;
}

function parseRows(tsv: string): DownloadRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as DownloadRow;
  });
}

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);

const REFERRER_HEADER: Record<Referrer, string | undefined> = {
  none: undefined,
  external: "https://evil.example/page",
  same_origin: "https://expanpress.com/",
};

function linkFor(token: TokenState): Record<string, unknown> | null {
  const future = new Date(Date.now() + 100_000).toISOString();
  const past = new Date(Date.now() - 10_000).toISOString();
  switch (token) {
    case "valid":
      return { sale_id: "s1", product_id: "p1", expires_at: future };
    case "expired":
      return { sale_id: "s1", product_id: "p1", expires_at: past };
    case "no_expiry":
      return { sale_id: "s1", product_id: "p1", expires_at: null };
    case "unknown":
    case "malformed":
      return null;
  }
}

function tokenFor(token: TokenState): string {
  if (token === "malformed") return "short";
  if (token === "unknown") return UNKNOWN_TOKEN;
  return VALID_TOKEN;
}

/** The expected outcome, from the route contract: 404 invalid/unknown, 410 expired, 500 fail-closed, 200 HEAD, 302 GET. */
function expectedOutcome(row: DownloadRow): { status: number; redirects: boolean; logs: boolean } {
  switch (row.token_state) {
    case "malformed":
    case "unknown":
      return { status: 404, redirects: false, logs: false };
    case "expired":
      return { status: 410, redirects: false, logs: false };
    case "no_expiry":
      return { status: 500, redirects: false, logs: false };
    case "valid":
      if (row.method === "HEAD") return { status: 200, redirects: false, logs: false };
      if (row.release_present === "no") return { status: 500, redirects: false, logs: false };
      return { status: 302, redirects: true, logs: true };
  }
}

describe("download link valid path: PICT pairwise artifact integrity", () => {
  it("saved rows file matches live PICT output and covers all generated rows", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const liveOut = execFileSync(PICT_BIN, [MODEL_PATH, `/e:${SEED_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(liveOut.trim()).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });

  it("keeps the seeded valid GET row with release present (the 302 + download_completed path)", () => {
    expect(ROWS.some((r) => r.token_state === "valid" && r.method === "GET" && r.release_present === "yes")).toBe(true);
  });
});

describe("download link valid path: PICT pairwise rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    for (const k of ["R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "CLOUDFLARE_R2_BUCKET"]) {
      vi.stubEnv(k, "");
    }
    fakeSb.from.mockImplementation((table: string) => {
      if (table === "download_events") {
        return { ...chain(() => ({ data: state.link, error: null })), insert: insertMock };
      }
      return chain(() => ({ data: state.product, error: null }));
    });
    fakeSb.storage.from.mockImplementation(() => ({ createSignedUrl: createSignedUrlMock, list: listMock }));
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    listMock.mockResolvedValue({ data: [], error: null });
    insertMock.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(ROWS.map((r) => [r.rowNum, r] as const))("row %i", async (_n, row) => {
    state.link = linkFor(row.token_state);
    state.product = row.release_present === "yes" ? { release_path: "books/test.pdf" } : { release_path: null };

    const token = tokenFor(row.token_state);
    const headers: Record<string, string> = {};
    const referer = REFERRER_HEADER[row.referrer];
    if (referer) headers.referer = referer;
    const req = new NextRequest(`https://expanpress.com/books/d/${token}`, { headers });
    const ctx = { params: Promise.resolve({ token }) };
    const res = row.method === "GET" ? await GET(req, ctx) : await HEAD(req, ctx);

    const want = expectedOutcome(row);
    expect(res.status).toBe(want.status);

    // Every response carries these two headers, whatever the outcome or the incoming referrer.
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");

    if (want.redirects) {
      expect(res.headers.get("location")).toBe(SIGNED_URL);
    } else {
      expect(res.headers.get("location")).toBeNull();
    }

    if (row.method === "HEAD") {
      // HEAD is a bodyless probe and must never write a download_completed row.
      expect(await res.text()).toBe("");
      expect(insertMock).not.toHaveBeenCalled();
    } else if (want.logs) {
      expect(insertMock).toHaveBeenCalledTimes(1);
      expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ event_type: "download_completed", sale_id: "s1" }));
    } else {
      expect(insertMock).not.toHaveBeenCalled();
    }
  });
});
