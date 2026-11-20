// Pairwise (PICT) test for consistency-high fixes:
//   1. Checkout geo-gate 403 Forbidden (HTML vs JSON vs plain text vs HEAD)
//   2. Download landing 404 Not Found / 410 Gone / 500 Internal Server Error (HTML vs plain text) vs 302 Found
//   3. Creator hub house bio fallback & registry disclaimers
//   4. Buyer delivery email HTML card branding & escaping
// Model: docs/testing/pairwise/consistency_surfaces.model.txt
// Rows:  docs/testing/pairwise/consistency_surfaces.rows.tsv (17 PICT rows, every row asserted)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL } from "../../payments/src/settings_registry";
import { deliverSale, StaleFenceError, type DeliveryDeps } from "../../payments/src/delivery";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: vi.fn(), getSession: vi.fn() },
  })),
}));

const downloadMock = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  insert: vi.fn(),
  createSignedUrl: vi.fn(),
  list: vi.fn(),
}));

const hubMock = vi.hoisted(() => ({
  isHouse: true,
  hasBio: true,
}));

vi.mock("../../payments/src/supabase_admin", () => ({
  getSupabaseAdmin: vi.fn(async () => ({
    from: (table: string) => {
      if (table === "download_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: downloadMock.maybeSingle,
              }),
            }),
          }),
          insert: downloadMock.insert,
        };
      }
      if (table === "products") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: downloadMock.maybeSingle,
            }),
          }),
        };
      }
      return {};
    },
    storage: {
      from: () => ({
        createSignedUrl: downloadMock.createSignedUrl,
        list: downloadMock.list,
      }),
    },
  })),
}));

vi.mock("../src/components/storefront/storefront", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/storefront/storefront")>();
  return {
    ...actual,
    fetchCreatorHub: vi.fn(async () => ({
      creator: {
        handle: hubMock.isHouse ? "expanpress_house" : "alice_smith",
        display_name: hubMock.isHouse ? GLOBAL.storefront.brand_name : "Alice Smith",
        platform_handles: null,
        bio: hubMock.hasBio ? "Custom creator biography." : null,
        photo: null,
        products: [
          {
            id: "00000000-0000-4000-8000-0000000000c1",
            store_product_id: "prod_c1",
            slug: "sample_book",
            title: "Sample Book",
            price_usd: "9",
            currency: "USD",
            working_note: null,
            description: "Sample description.",
            disclaimers: [],
            checkout_mode: "gated",
            is_sample: true,
            inside: [],
            preview_pdf: null,
            overview: null,
          },
        ],
      },
      origin: "https://expanpress.com",
    })),
  };
});

import { proxy } from "../proxy";
import { GET as downloadGet } from "../app/books/d/[token]/route";
import CreatorHubPage from "../app/books/[handle]/page";

const PICT_BIN = "/usr/local/bin/pict";
const MODEL_PATH = fileURLToPath(
  new URL("../../docs/testing/pairwise/consistency_surfaces.model.txt", import.meta.url),
);
const ROWS_PATH = fileURLToPath(
  new URL("../../docs/testing/pairwise/consistency_surfaces.rows.tsv", import.meta.url),
);
const EXPECTED_ROW_COUNT = 17;

interface ConsistencyRow {
  rowNum: number;
  checkout_method: "GET" | "HEAD";
  checkout_path: "page" | "api";
  buyer_country: "US" | "DE" | "missing";
  accept_header: "html" | "json" | "none";
  download_state: "invalid_token" | "missing_row" | "expired" | "missing_expiry" | "valid";
  hub_creator_kind: "house" | "external";
  hub_has_bio: "true" | "false";
  delivery_billing: "same" | "distinct" | "omitted";
  delivery_title: "plain" | "xss";
}

function parseRows(tsv: string): ConsistencyRow[] {
  const [header, ...lines] = tsv.trim().split(/\r?\n/);
  const cols = header.split("\t");
  return lines.map((line, idx) => {
    const cells = line.split("\t");
    const rec = Object.fromEntries(cols.map((col, colIdx) => [col, cells[colIdx]]));
    return { rowNum: idx + 1, ...rec } as ConsistencyRow;
  });
}

const ACCEPT_VALUE: Record<ConsistencyRow["accept_header"], string | undefined> = {
  html: "text/html,application/xhtml+xml",
  json: "application/json",
  none: undefined,
};

const ROWS_TSV = readFileSync(ROWS_PATH, "utf8");
const ROWS = parseRows(ROWS_TSV);
const VALID_TOKEN = "B".repeat(43);

function makeDeliveryFakes(title: string, billingEmail?: string): { deps: DeliveryDeps; sendEmail: ReturnType<typeof vi.fn> } {
  const sendEmail = vi.fn(async () => ({ id: "email-1" }));
  const sendClaims = new Map<string, { state: "claimed" | "sent"; fence: number }>();
  const messages = new Map<string, string>();
  const keyOf = (provider: string, saleId: string, sendKind: string) => `${provider}:${saleId}:${sendKind}`;
  const deps: DeliveryDeps = {
    db: {
      productForAlias: vi.fn(async () => ({ id: "p-pw", title, releasePath: "books/pw.pdf" })),
      recordLinkIssued: vi.fn(async () => true),
      releaseLinkIssued: vi.fn(async () => undefined),
      linkStillIssued: vi.fn(async () => true),
      deliveryConfirmed: vi.fn(async () => false),
      confirmDelivery: vi.fn(async () => undefined),
      claimDeliverySend: vi.fn(async ({ provider, saleId, sendKind, fence }) => {
        const key = keyOf(provider, saleId, sendKind);
        sendClaims.set(key, { state: "claimed", fence: fence ?? 0 });
        return { outcome: "claimed" as const, fence: fence ?? 0 };
      }),
      assertSendFence: vi.fn(async () => undefined),
      markDeliverySent: vi.fn(async ({ provider, saleId, sendKind }) => {
        const key = keyOf(provider, saleId, sendKind);
        const existing = sendClaims.get(key);
        if (!existing) throw new StaleFenceError("delivery_sends", key, 0, 0);
        existing.state = "sent";
      }),
      releaseDeliverySend: vi.fn(async () => undefined),
      storeClaimMessage: vi.fn(async ({ provider, saleId, sendKind, ciphertext }) => {
        messages.set(keyOf(provider, saleId, sendKind), ciphertext);
      }),
      readClaimMessage: vi.fn(async ({ provider, saleId, sendKind }) => messages.get(keyOf(provider, saleId, sendKind)) ?? null),
    },
    sendEmail,
    createShortLink: vi.fn(async () => "https://go.expanpress.com/pw123"),
    origin: "https://expanpress.com",
    replyTo: GLOBAL.email.support,
    billingEmail,
    now: () => new Date("2026-11-20T12:00:00Z"),
    newToken: () => VALID_TOKEN,
    linkKey: Buffer.alloc(32, 9),
  };
  return { deps, sendEmail };
}

beforeEach(() => {
  vi.clearAllMocks();
  downloadMock.list.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("consistency surfaces: PICT pairwise", () => {
  it("checked-in rows TSV matches /usr/local/bin/pict output (no model drift)", () => {
    if (!existsSync(PICT_BIN)) {
      if (process.env.CI) throw new Error(`pict binary missing at ${PICT_BIN}`);
      return;
    }
    const generated = execFileSync(PICT_BIN, [MODEL_PATH], { encoding: "utf8" }).trim();
    expect(generated).toBe(ROWS_TSV.trim());
    expect(ROWS).toHaveLength(EXPECTED_ROW_COUNT);
  });

  it.each(ROWS)(
    "row $rowNum: $checkout_method $checkout_path country=$buyer_country accept=$accept_header dl=$download_state hub=$hub_creator_kind/$hub_has_bio email=$delivery_billing/$delivery_title",
    async (row) => {
      // 1. Checkout geo-gate (403 Forbidden vs 200 OK)
      const url =
        row.checkout_path === "page"
          ? "https://pay.expanpress.com/checkout/00000000-0000-4000-8000-0000000000c1"
          : "https://pay.expanpress.com/api/billing/checkout?product=p1";
      const headers = new Headers();
      if (row.buyer_country !== "missing") headers.set("x-vercel-ip-country", row.buyer_country);
      const acceptVal = ACCEPT_VALUE[row.accept_header];
      if (acceptVal) headers.set("accept", acceptVal);

      const proxyRes = await proxy({
        cookies: { getAll: () => [], set: () => undefined },
        url,
        method: row.checkout_method,
        headers,
      } as never);

      if (row.buyer_country === "DE") {
        expect(proxyRes.status).toBe(403);
        const bodyText = await proxyRes.text();
        if (row.checkout_method === "HEAD") {
          expect(bodyText).toBe("");
        } else if (row.checkout_path === "api") {
          expect(proxyRes.headers.get("content-type")).toContain("application/json");
          expect(JSON.parse(bodyText)).toMatchObject({ ok: false, code: "country_not_supported" });
        } else if (row.accept_header === "html") {
          expect(proxyRes.headers.get("content-type")).toContain("text/html");
          expect(bodyText).toContain("403 Forbidden");
          expect(bodyText).toContain('<span class="brace">{</span><span class="name">expanpress</span><span class="brace">}</span>');
          expect(bodyText).toContain(GLOBAL.storefront.b2c_landing_url);
          expect(bodyText).toContain(GLOBAL.email.support);
        } else {
          expect(proxyRes.headers.get("content-type")).toContain("text/plain");
          expect(bodyText).toContain("United States");
        }
      } else {
        expect(proxyRes.status).toBe(200);
      }

      // 2. Download landing (404 Not Found / 410 Gone / 500 Internal Server Error / 302 Found)
      const dlHeaders = new Headers();
      if (acceptVal) dlHeaders.set("accept", acceptVal);
      let token = VALID_TOKEN;
      let expectedStatus = 302;
      if (row.download_state === "invalid_token") {
        token = "short";
        expectedStatus = 404;
      } else if (row.download_state === "missing_row") {
        downloadMock.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
        expectedStatus = 404;
      } else if (row.download_state === "expired") {
        downloadMock.maybeSingle.mockResolvedValueOnce({
          data: { sale_id: "s1", product_id: "p1", expires_at: new Date(Date.now() - 10_000).toISOString() },
          error: null,
        });
        expectedStatus = 410;
      } else if (row.download_state === "missing_expiry") {
        downloadMock.maybeSingle.mockResolvedValueOnce({
          data: { sale_id: "s1", product_id: "p1", expires_at: null },
          error: null,
        });
        expectedStatus = 500;
      } else {
        downloadMock.maybeSingle
          .mockResolvedValueOnce({
            data: { sale_id: "s1", product_id: "p1", expires_at: new Date(Date.now() + 60_000).toISOString() },
            error: null,
          })
          .mockResolvedValueOnce({ data: { release_path: "books/pw.pdf" }, error: null });
        downloadMock.createSignedUrl.mockResolvedValueOnce({
          data: { signedUrl: "https://storage.example/signed.pdf" },
          error: null,
        });
        downloadMock.insert.mockResolvedValueOnce({ error: null });
      }
      const dlRes = await downloadGet(new NextRequest(`https://expanpress.com/books/d/${token}`, { headers: dlHeaders }), {
        params: Promise.resolve({ token }),
      });
      expect(dlRes.status).toBe(expectedStatus);
      if (expectedStatus !== 302) {
        const dlBody = await dlRes.text();
        if (row.accept_header === "html") {
          expect(dlRes.headers.get("content-type")).toContain("text/html");
          expect(dlBody).toContain('<span class="brace">{</span><span class="name">expanpress</span><span class="brace">}</span>');
          expect(dlBody).toContain(GLOBAL.storefront.b2c_landing_url);
          expect(dlBody).toContain(GLOBAL.email.support);
          expect(dlBody).toContain(String(expectedStatus));
        } else {
          expect(dlRes.headers.get("content-type")).toContain("text/plain");
        }
      }

      // 3. Creator hub bio & disclaimers
      hubMock.isHouse = row.hub_creator_kind === "house";
      hubMock.hasBio = row.hub_has_bio === "true";
      const hubHtml = renderToStaticMarkup(
        await CreatorHubPage({ params: Promise.resolve({ handle: hubMock.isHouse ? "expanpress_house" : "alice_smith" }) }),
      );
      expect(hubHtml).not.toContain("Creator bio coming soon.");
      expect(hubHtml).not.toContain("buy, sell, or hold any security");
      const decodedHubHtml = hubHtml.replace(/&#x27;/g, "'");
      for (const disclaimer of GLOBAL.landing.disclaimers) {
        expect(decodedHubHtml).toContain(disclaimer);
      }
      if (hubMock.hasBio) {
        expect(hubHtml).toContain("Custom creator biography.");
      } else if (hubMock.isHouse) {
        expect(decodedHubHtml).toContain(GLOBAL.storefront.house_creator_bio);
      } else {
        expect(decodedHubHtml).not.toContain(GLOBAL.storefront.house_creator_bio);
      }

      // 4. Buyer delivery email HTML card
      const title = row.delivery_title === "xss" ? "<img src=x onerror=alert(1)>" : "The Quiet Workshop";
      const billingEmail =
        row.delivery_billing === "distinct"
          ? GLOBAL.email.billing
          : row.delivery_billing === "same"
            ? GLOBAL.email.support
            : undefined;
      const { deps, sendEmail } = makeDeliveryFakes(title, billingEmail);
      await deliverSale(
        { provider: "paddle", saleId: `s-${row.rowNum}`, productAlias: "a1", buyerEmail: "buyer@example.com" },
        deps,
      );
      const sent = sendEmail.mock.calls[0]?.[0] as { text: string; html: string };
      expect(sent.html).toContain(GLOBAL.branding.colors.canvas);
      expect(sent.html).toContain(GLOBAL.branding.colors.button_primary);
      expect(sent.html).toContain(`{</span>${GLOBAL.storefront.brand_name.toLowerCase()}<span`);
      expect(sent.html).toContain("Download your book");
      expect(sent.html).toContain(GLOBAL.email.support);
      expect(sent.html).toContain(`&copy; ${new Date().getUTCFullYear()} ${GLOBAL.storefront.brand_name}`);
      expect(sent.html).toContain(GLOBAL.branding.colors.surface);
      expect(sent.html).toContain(GLOBAL.branding.email_font_stack);
      if (row.delivery_title === "xss") {
        expect(sent.html).not.toContain("<img");
        expect(sent.html).toContain("&#60;img");
      }
      if (row.delivery_billing === "distinct") {
        expect(sent.html).toContain(GLOBAL.email.billing);
        expect(sent.text).toContain(GLOBAL.email.billing);
      } else {
        expect(sent.html).not.toContain("billing or refund questions:");
      }
    },
  );
});
