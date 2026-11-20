// PICT pairwise test for pay. root branding, host confinement, country blocking, and E2E_PROXY_HOST_OVERRIDE.
// Model: docs/testing/pairwise/pay_root.model.txt
// Rows:  docs/testing/pairwise/pay_root.rows.tsv (46 generated PICT rows)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";
import { proxy } from "../proxy";

const MODEL_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/pay_root.model.txt");
const ROWS_PATH = path.resolve(import.meta.dirname, "../../docs/testing/pairwise/pay_root.rows.tsv");
const PICT_BIN = "/usr/local/bin/pict";
const EXPECTED_ROW_COUNT = 46;

type HostToken = "pay_host" | "main_host" | "www_host" | "localhost";
type PathToken =
  | "root"
  | "checkout_page"
  | "checkout_api"
  | "buyer_legal"
  | "buyer_providers"
  | "creator_legal"
  | "books"
  | "favicon"
  | "robots";

interface PayRootRow {
  rowNum: number;
  url_host: HostToken;
  host_header: HostToken;
  node_env: "development" | "production";
  host_override: "enabled" | "disabled";
  path: PathToken;
  method: "GET" | "HEAD";
  country: "US" | "DE" | "empty";
}

function parseRows(tsv: string): PayRootRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, i) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((c, idx) => [c, cells[idx]]));
    return { rowNum: i + 1, ...rec } as PayRootRow;
  });
}

const HOST_MAP: Record<HostToken, string> = {
  pay_host: "pay.expanpress.com",
  main_host: "expanpress.com",
  www_host: "www.expanpress.com",
  localhost: "localhost:3100",
};

const PATH_MAP: Record<PathToken, string> = {
  root: "/",
  checkout_page: "/checkout/00000000-0000-4000-8000-0000000000b2",
  checkout_api: "/api/billing/checkout",
  buyer_legal: "/books/legal/terms.html",
  buyer_providers: "/books/legal/providers.html",
  creator_legal: "/terms.html",
  books: "/books",
  favicon: "/favicon.ico",
  robots: "/robots.txt",
};

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pay_root: PICT pairwise artifact integrity", () => {
  it("saved rows file matches live PICT output and covers all generated rows", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const liveOut = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8" }).trim();
    expect(liveOut).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });
});

describe(`pay_root: ${EXPECTED_ROW_COUNT} PICT pairwise rows`, () => {
  it.each(ROWS)(
    "row #$rowNum: url=$url_host hdr=$host_header env=$node_env ovr=$host_override path=$path method=$method country=$country",
    async (row) => {
      vi.stubEnv("NODE_ENV", row.node_env);
      vi.stubEnv("E2E_PROXY_HOST_OVERRIDE", row.host_override === "enabled" ? "1" : "0");

      const base = row.url_host === "localhost" ? "http://localhost:3100" : `https://${HOST_MAP[row.url_host]}`;
      const reqPath = PATH_MAP[row.path];
      const headers: Record<string, string> = { host: HOST_MAP[row.host_header] };
      if (row.country !== "empty") headers["x-vercel-ip-country"] = row.country;

      const req = {
        cookies: { getAll: () => [], set: () => undefined },
        url: `${base}${reqPath}`,
        method: row.method,
        headers: new Headers(headers),
      };

      const res = await proxy(req as never);

      const effectiveHost: HostToken =
        row.url_host === "localhost" &&
        row.node_env !== "production" &&
        row.host_override === "enabled" &&
        row.host_header === "pay_host"
          ? "pay_host"
          : row.url_host;

      const isCheckout = row.path === "checkout_page" || row.path === "checkout_api";

      if (effectiveHost === "pay_host") {
        if (row.path === "robots") {
          expect(res.status).toBe(200);
          expect(res.headers.get("x-middleware-rewrite")).toContain("/robots-pay.txt");
          return;
        }
        if (row.path === "root") {
          expect(res.status).toBe(200);
          expect(res.headers.get("location")).toBeNull();
          expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
          expect(res.headers.get("cache-control")).toBe("public, max-age=300");
          const body = await res.text();
          if (row.method === "HEAD") {
            expect(body).toBe("");
          } else {
            expect(body).toContain(GLOBAL.storefront.pay_root_heading);
            expect(body).toContain(GLOBAL.storefront.b2c_landing_url);
            expect(body).not.toContain("/creator/");
            for (const link of GLOBAL.storefront.buyer_legal_links) {
              expect(body).toContain(link.path);
            }
          }
          return;
        }
        if (row.path === "creator_legal" || row.path === "books") {
          expect(res.status).toBe(404);
          expect(res.headers.get("location")).toBeNull();
          return;
        }
        if (isCheckout && row.country === "DE") {
          expect(res.status).toBe(403);
          return;
        }
        expect(res.status).toBe(200);
        if (row.path === "buyer_providers") {
          expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
        }
        return;
      }

      // Non-pay host
      if (isCheckout && row.country === "DE") {
        expect(res.status).toBe(403);
        return;
      }
      if (isCheckout && (effectiveHost === "main_host" || effectiveHost === "www_host")) {
        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe(`https://pay.expanpress.com${reqPath}`);
        return;
      }
      expect(res.status).toBe(200);
      if (row.path === "buyer_providers") {
        expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
    },
  );
});
