/**
 * B2C / B2B confinement (ADR 0061 host boundary, b2c-separation).
 *
 * B2C = /books (landing, creator, product, thank-you) and the buyer legal set at
 * /books/legal/*. B2B = everything else on the main host, including the creator
 * legal set at /terms.html, /privacy.html, /refund-policy.html, /legal/providers.html.
 *
 * Backend = e2e/mock-supabase.ts (server-side Supabase calls; see playwright.config.ts).
 * Test (d), the pay-host boundary, needs a real pay hostname (PAY_HOST_LIVE): `next dev` builds
 * request.url from its listen address, so a Host header cannot reach the proxy's host check locally.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, request as apiRequest, type Page } from "@playwright/test";
import { APP_URL, E2E, MOCK_HTTP_URL } from "./constants";

/** Screenshot folder. Override with B2C_SHOTS_DIR; the default is test-results/ (gitignored). */
const SHOTS_DIR =
  process.env.B2C_SHOTS_DIR ??
  path.join(process.cwd(), "test-results", "b2c-shots");

const B2C_HOME_ABS = "https://expanpress.com/books";
const PRODUCT_HREF = `/books/${E2E.liveCreatorHandle}/${E2E.liveProductSlug}`;
const CREATOR_HREF = `/books/${E2E.liveCreatorHandle}`;
const THANKS_HREF = `${CREATOR_HREF}/thanks`;
const PAY_BUY_HREF = `https://pay.expanpress.com/checkout/${E2E.liveProductId}`;

/** Allowed on landing, creator, product and thank-you pages. */
const underBooks = (h: string) => /^\/books(?:[/?#]|$)/.test(h);
const b2cHomeAbs = (h: string) => h === B2C_HOME_ABS;
const payCheckout = (h: string) => /^https:\/\/pay\.expanpress\.com\/checkout\/[^/?#]+$/.test(h);
const B2C_PAGE_RULE = (h: string) => underBooks(h) || b2cHomeAbs(h) || payCheckout(h);

/** Buyer legal pages: /books, /books/legal/*, or the absolute B2C home. Nothing else, and no pay checkout. */
const buyerLegalRule = (h: string) => h === "/books" || /^\/books\/legal\/[^/?#]+$/.test(h) || b2cHomeAbs(h);

/** Explicit B2B targets, named so a failure message says which boundary was crossed. */
const B2B_PATHS = ["/", "/creator", "/terms.html", "/privacy.html", "/refund-policy.html", "/legal/providers.html"];

function hrefsOf(page: Page): Promise<string[]> {
  return page.locator("a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
}

function outside(hrefs: string[], rule: (h: string) => boolean): string[] {
  return hrefs.filter((h) => !rule(h)).map((h) => `${h || "<empty href>"}${B2B_PATHS.includes(h) ? " [B2B path]" : ""}`);
}

test.beforeAll(async () => {
  await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
  mkdirSync(SHOTS_DIR, { recursive: true });
});

test("(a) GET /books returns 200 and renders the landing with the ExpanPress logo", async ({ page }) => {
  const res = await page.goto("/books");
  expect(res?.status(), "GET /books status").toBe(200);
  await expect(page.getByRole("heading", { name: "Find a book from a creator" })).toBeVisible();
  // The fixture creator has a live book, so the landing lists it instead of the empty state.
  await expect(page.getByText("No books are on sale yet")).toHaveCount(0);
  await expect(page.locator(`a[href="${CREATOR_HREF}"]`)).toBeVisible();
  const logo = page.getByRole("link", { name: "ExpanPress home" });
  await expect(logo).toBeVisible();
  const logoHref = await logo.getAttribute("href");
  expect(logoHref === B2C_HOME_ABS || logoHref === "/books", `logo href was ${logoHref}`).toBe(true);
});

test("(b) crawl: links from /books, the first creator page, the first product page stay in B2C", async ({ page }) => {
  // Landing
  await page.goto("/books");
  const landing = await hrefsOf(page);
  expect(outside(landing, B2C_PAGE_RULE), "landing links outside B2C").toEqual([]);
  const firstCreator = landing.find((h) => /^\/books\/[^/]+$/.test(h));
  expect(firstCreator, "first creator link on /books").toBe(CREATOR_HREF);

  // First creator page
  const creatorRes = await page.goto(firstCreator!);
  expect(creatorRes?.status(), "creator page status").toBe(200);
  const creator = await hrefsOf(page);
  expect(outside(creator, B2C_PAGE_RULE), "creator page links outside B2C").toEqual([]);
  const firstProduct = creator.find((h) => /^\/books\/[^/]+\/[^/]+$/.test(h) && !h.endsWith("/thanks"));
  expect(firstProduct, "first product link on creator page").toBe(PRODUCT_HREF);

  // First product page, including the buy button, which must be the pay checkout.
  const productRes = await page.goto(firstProduct!);
  expect(productRes?.status(), "product page status").toBe(200);
  const product = await hrefsOf(page);
  expect(outside(product, B2C_PAGE_RULE), "product page links outside B2C").toEqual([]);
  // Clean BuyLink on the product page pointing to pay.expanpress.com/checkout/<id> (zero buyer email PII in URL).
  await expect(page.locator('[data-checkout-slot="primary"]')).toHaveAttribute("href", PAY_BUY_HREF);
});

test("(b3) checkout page renders single-hop BuyerEmailStep POST form with MoR disclosure", async ({ page }) => {
  const res = await page.goto(`/checkout/${E2E.liveProductId}?src=ig`);
  expect(res?.status(), "checkout page status").toBe(200);
  await expect(page.getByText(/Merchant of Record/)).toBeVisible();
  const form = page.locator('form:has([data-checkout-slot="primary"])');
  await expect(form).toHaveAttribute("action", "/api/billing/checkout");
  await expect(form).toHaveAttribute("method", "post");
  await expect(form.locator('input[name="product"]')).toHaveValue(E2E.liveProductId);
  await expect(form.locator('input[name="buyer_email"]')).toBeVisible();
  await expect(form.locator('input[name="buyer_email_confirm"]')).toBeVisible();
  await expect(form.locator('input[name="buyer_consent"]')).toBeChecked();
  await expect(form.locator('input[name="src"]')).toHaveValue("ig");
  await expect(form.locator('[data-checkout-slot="primary"]')).toBeDisabled();
  await form.locator('input[name="buyer_email"]').fill("buyer@example.com");
  await form.locator('input[name="buyer_email_confirm"]').fill("buyer@example.com");
  await expect(form.locator('[data-checkout-slot="primary"]')).toBeEnabled();
});

test("(b2) thank-you page links stay in B2C", async ({ page }) => {
  const res = await page.goto(THANKS_HREF);
  expect(res?.status(), "thank-you page status").toBe(200);
  const links = await hrefsOf(page);
  expect(outside(links, B2C_PAGE_RULE), "thank-you links outside B2C").toEqual([]);
});

for (const page_ of ["terms", "privacy", "refund-policy", "providers"]) {
  test(`(c) /books/legal/${page_}.html links are /books, /books/legal/*, or ${B2C_HOME_ABS}`, async ({ page }) => {
    const res = await page.goto(`/books/legal/${page_}.html`);
    expect(res?.status(), "buyer legal page status").toBe(200);
    const links = await hrefsOf(page);
    expect(links.length, "legal page has links").toBeGreaterThan(0);
    expect(outside(links, buyerLegalRule), `links outside buyer legal rule`).toEqual([]);
  });
}

test("(d) pay host: /terms.html and /books are 404, /books/legal/terms.html is 200", async () => {
  // Local harness cannot prove the pay boundary: the proxy keys on the listen address, not the Host header
  // (KNOWN HARNESS GAP below). The live boundary is verified against the real pay hostname with curl.
  test.skip(!process.env.PAY_HOST_LIVE, "needs a real pay hostname; verified against production with curl");
  const main = await apiRequest.newContext({ baseURL: APP_URL, maxRedirects: 0 });
  const pay = await apiRequest.newContext({
    baseURL: APP_URL,
    maxRedirects: 0,
    extraHTTPHeaders: { host: "pay.expanpress.com" },
  });
  try {
    // Precondition: the proxy must see the host each context claims, or the 404s below prove nothing.
    // KNOWN HARNESS GAP: the Host header reaches the server (probe hostHeader = pay.expanpress.com), but `next dev`
    // builds request.url from its listen address, so proxy.ts sees "localhost". This assertion fails until the
    // pay boundary can be reached with a real pay hostname (see the run report).
    // The probe route exists only in dev builds (proxy.ts: NODE_ENV !== "production"). In the production run the
    // control assertions below carry the proof: the same path returns 200 on main and 404 on pay.
    if (process.env.E2E_PROD !== "1") {
      const seenMain = await (await main.get("/__e2e/proxy-host")).json();
      const seenPay = await (await pay.get("/__e2e/proxy-host")).json();
      expect(seenMain.requestUrlHostname, "proxy host seen on main context").toBe("localhost");
      expect(seenPay.requestUrlHostname, "proxy host seen on pay context").toBe("pay.expanpress.com");
    }

    // Control: the same paths on the main host. Proves the 404s below come from the pay host, not the paths.
    expect((await main.get("/terms.html")).status(), "control: main /terms.html").toBe(200);
    expect((await main.get("/books/legal/terms.html")).status(), "control: main /books/legal/terms.html").toBe(200);

    expect((await pay.get("/terms.html")).status(), "pay /terms.html").toBe(404);
    expect((await pay.get("/books")).status(), "pay /books").toBe(404);
    expect((await pay.get("/books/legal/terms.html")).status(), "pay /books/legal/terms.html").toBe(200);
  } finally {
    await main.dispose();
    await pay.dispose();
  }
});

test("(e) screenshots of B2C pages and the B2B creator legal page", async ({ page }) => {
  const shots: Array<[string, string]> = [
    ["/books", "01-b2c-landing.png"],
    [CREATOR_HREF, "02-b2c-creator-page.png"],
    [PRODUCT_HREF, "03-b2c-product-page.png"],
    [`/checkout/${E2E.liveProductId}`, "07-b2c-checkout-page.png"],
    [THANKS_HREF, "04-b2c-thanks-page.png"],
    ["/books/legal/terms.html", "05-b2c-buyer-legal-terms.png"],
    ["/terms.html", "06-b2b-creator-legal-terms.png"],
  ];
  for (const [url, file] of shots) {
    const res = await page.goto(url);
    expect(res?.status(), `${url} status`).toBe(200);
    await page.screenshot({ path: path.join(SHOTS_DIR, file), fullPage: true });
  }
});
