/**
 * Paddle.js Option A sandbox purchase E2E:
 *   /checkout/<sample-product-id> -> BuyerEmailStep -> POST /api/billing/checkout (200 OK paddle_overlay)
 *   -> real Paddle.js sandbox overlay + published test card -> local /books/expanpress_house/thanks
 *   -> signed transaction.completed webhook -> /api/billing/webhook (200 OK)
 *   -> local Resend + Dub capture -> HEAD/GET /books/d/<token> (200 OK / 302 Found -> %PDF-).
 *
 * Sandbox only: refuses live tokens/keys, aborts any live Paddle or production ExpanPress request,
 * and intercepts successUrl (https://expanpress.com/books/...) locally on APP_URL.
 * Runs when E2E_PADDLE_SANDBOX=1 and NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is a sandbox test_* token.
 */
import crypto from "node:crypto";
import { test, expect, request as apiRequest, type FrameLocator, type Page } from "@playwright/test";
import { APP_URL, E2E, MOCK_HTTP_URL } from "./constants";

const SANDBOX_ENABLED = process.env.E2E_PADDLE_SANDBOX === "1";
const CLIENT_TOKEN = (process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "").trim();
const SANDBOX_API_KEY = (process.env.PADDLE_SANDBOX_API_KEY ?? "").trim();

interface SandboxTransactionRecord {
  id: string;
  status: string;
  currency_code: string;
  customer_id?: string | null;
  changed_at?: string | null;
  created_at?: string | null;
  details?: { totals?: { total?: string } };
  custom_data?: Record<string, unknown> | null;
  items?: Array<{ price?: { id?: string } }>;
}

async function fetchSandboxTransaction(
  txnId: string | null,
  startedAtMs: number,
  priceId: string,
): Promise<SandboxTransactionRecord | null> {
  if (!SANDBOX_API_KEY.startsWith("pdl_sdbx_")) return null;
  const headers = { Authorization: `Bearer ${SANDBOX_API_KEY}` };
  if (txnId) {
    const res = await fetch(`https://sandbox-api.paddle.com/transactions/${encodeURIComponent(txnId)}`, { headers });
    if (res.ok) {
      const json = (await res.json()) as { data?: SandboxTransactionRecord };
      if (json.data) return json.data;
    }
  }
  const listRes = await fetch(
    "https://sandbox-api.paddle.com/transactions?status=completed&order_by=created_at[DESC]&per_page=10",
    { headers },
  );
  if (!listRes.ok) return null;
  const listJson = (await listRes.json()) as { data?: SandboxTransactionRecord[] };
  return (
    (listJson.data ?? []).find((t) => {
      const createdMs = t.created_at ? Date.parse(t.created_at) : 0;
      const hasPrice = (t.items ?? []).some((i) => i.price?.id === priceId);
      return hasPrice && createdMs >= startedAtMs - 10_000;
    }) ?? null
  );
}

function signPaddleWebhook(secret: string, body: string, tsSeconds: number): string {
  const h1 = crypto.createHmac("sha256", secret).update(`${tsSeconds}:${body}`, "utf8").digest("hex");
  return `ts=${tsSeconds};h1=${h1}`;
}

async function fillFirstVisible(
  frame: FrameLocator,
  selectors: string[],
  value: string,
): Promise<boolean> {
  for (const sel of selectors) {
    const loc = frame.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.fill(value);
      return true;
    }
  }
  return false;
}

async function clickFirstVisible(frame: FrameLocator, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const loc = frame.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false)) && (await loc.isEnabled().catch(() => false))) {
      await loc.click();
      return true;
    }
  }
  return false;
}

async function locatePaddleOverlayFrame(page: Page): Promise<FrameLocator> {
  const iframeLoc = page.locator('iframe[src*="paddle"], iframe[name*="paddle"]').first();
  await expect(iframeLoc).toBeVisible({ timeout: 30_000 });
  return page.frameLocator('iframe[src*="paddle"], iframe[name*="paddle"]').first();
}

test.describe("Paddle.js Option A sandbox purchase + thank-you + delivery", () => {
  test.beforeEach(async () => {
    await fetch(`${MOCK_HTTP_URL}/__reset`, { method: "POST" });
  });

  test("completes one $9.00 sandbox overlay purchase with published test card and verifies thank-you copy and delivery", async ({
    page,
  }) => {
    test.skip(
      !SANDBOX_ENABLED || !CLIENT_TOKEN.startsWith("test_"),
      "Requires E2E_PADDLE_SANDBOX=1 and a sandbox NEXT_PUBLIC_PADDLE_CLIENT_TOKEN (test_*)",
    );

    // Fail closed against live Paddle and route production successUrl back to local APP_URL.
    await page.route("https://api.paddle.com/**", (route) => route.abort("blockedbyclient"));
    await page.route("https://checkout.paddle.com/**", (route) => route.abort("blockedbyclient"));

    let redirectedThanksUrl: string | null = null;
    await page.route("https://expanpress.com/**", async (route) => {
      const target = new URL(route.request().url());
      if (!target.pathname.startsWith("/books/")) {
        await route.abort("blockedbyclient");
        return;
      }
      if (target.pathname === `/books/${E2E.houseCreatorHandle}/thanks`) {
        redirectedThanksUrl = target.toString();
      }
      const localRes = await page.request.get(`${APP_URL}${target.pathname}${target.search}`);
      await route.fulfill({
        status: localRes.status(),
        headers: localRes.headers(),
        body: await localRes.body(),
      });
    });

    // Capture the real sandbox transaction id from any Paddle sandbox response.
    const testStartedAtMs = Date.now();
    let capturedTxnId: string | null = null;
    page.on("response", async (resp) => {
      const url = resp.url();
      if (!url.includes("paddle.com")) return;
      const urlMatch = url.match(/\b(txn_[a-z0-9]+)\b/i);
      if (urlMatch) capturedTxnId = urlMatch[1];
      const ct = resp.headers()["content-type"] ?? "";
      if (ct.includes("application/json")) {
        const text = await resp.text().catch(() => "");
        const bodyMatch = text.match(/\b(txn_[a-z0-9]+)\b/i);
        if (bodyMatch) capturedTxnId = bodyMatch[1];
      }
    });

    // 1. Open checkout page on local pay surface.
    const checkoutRes = await page.goto(`/checkout/${E2E.sandboxSampleProductId}?src=e2e_sandbox`);
    expect(checkoutRes?.status(), "GET /checkout/[productId] status").toBe(200);

    await expect(page.getByRole("heading", { name: "The Quiet Workshop (Sample)" })).toBeVisible();
    await expect(page.getByText("$9.00")).toBeVisible();
    await expect(page.getByText(/USD\s*·\s*one-time/)).toBeVisible();
    await expect(page.getByText(/Merchant of Record/)).toBeVisible();
    await expect(page.getByText(/usually within 2 minutes/)).toBeVisible();
    await expect(page.getByText(/within 1 hour, email support@expanpress\.com/)).toBeVisible();

    await page.locator('input[name="buyer_email"]').fill(E2E.sandboxBuyerEmail);
    await page.locator('input[name="buyer_email_confirm"]').fill(E2E.sandboxBuyerEmail);
    await expect(page.locator('input[name="buyer_consent"]')).toBeChecked();

    // 2. Submit BuyerEmailStep -> POST /api/billing/checkout (200 OK paddle_overlay) -> Paddle.js overlay opens.
    const [checkoutApiRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/billing/checkout") && r.request().method() === "POST"),
      page.locator('[data-checkout-slot="primary"]').click(),
    ]);
    expect(checkoutApiRes.status(), "POST /api/billing/checkout status").toBe(200);
    const checkoutJson = (await checkoutApiRes.json()) as {
      ok: boolean;
      kind: string;
      payload: {
        items: Array<{ priceId: string; quantity: number }>;
        customer?: { email: string };
        customData: Record<string, string>;
        settings: { successUrl: string };
      };
    };
    expect(checkoutJson.ok).toBe(true);
    expect(checkoutJson.kind).toBe("paddle_overlay");
    expect(checkoutJson.payload.items[0]?.priceId).toBe(E2E.sandboxSamplePriceId);
    expect(checkoutJson.payload.customer?.email).toBe(E2E.sandboxBuyerEmail);
    expect(checkoutJson.payload.customData.buyer_consent).toBe("true");
    expect(checkoutJson.payload.settings.successUrl).toBe(`https://expanpress.com/books/${E2E.houseCreatorHandle}/thanks`);

    // 3. Complete payment inside the real Paddle sandbox overlay using Paddle's published test card.
    const overlayFrame = await locatePaddleOverlayFrame(page);

    // Step 3a: Paddle may show an email/address step before the card step.
    await expect
      .poll(
        async () => {
          const hasCard =
            (await overlayFrame.locator('input[name="cardNumber"], input[autocomplete="cc-number"], input[id*="cardNumber"]').count()) > 0;
          const hasContinue =
            (await overlayFrame.locator('button:has-text("Continue")').count()) > 0;
          return hasCard || hasContinue;
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // Fill country / ZIP if shown before Continue, then click Continue if still on address/email step.
    const zipSel = ['input[name="postalCode"]', 'input[name="postcode"]', 'input[autocomplete="postal-code"]', 'input[placeholder*="ZIP" i]', 'input[placeholder*="Postal" i]'];
    const countrySel = ['select[name="countryCode"]', 'select[name="country"]'];
    for (const sel of countrySel) {
      const c = overlayFrame.locator(sel).first();
      if ((await c.count()) > 0 && (await c.isVisible().catch(() => false))) {
        await c.selectOption("US").catch(() => {});
        break;
      }
    }
    await fillFirstVisible(overlayFrame, zipSel, E2E.paddleTestCard.postal);
    await clickFirstVisible(overlayFrame, ['button:has-text("Continue")']);

    // Wait for card input fields (either directly in overlayFrame or nested payment iframe).
    await page.waitForTimeout(1_000);
    const cardFrame =
      (await overlayFrame.locator('iframe[src*="card"], iframe[name*="card"], iframe[title*="card" i]').count()) > 0
        ? overlayFrame.frameLocator('iframe[src*="card"], iframe[name*="card"], iframe[title*="card" i]').first()
        : overlayFrame;

    await expect(
      cardFrame.locator('input[name="cardNumber"], input[autocomplete="cc-number"], input[id*="cardNumber"], input[placeholder*="Card number" i]').first(),
    ).toBeVisible({ timeout: 30_000 });

    const filledNumber = await fillFirstVisible(
      cardFrame,
      ['input[name="cardNumber"]', 'input[autocomplete="cc-number"]', 'input[id*="cardNumber"]', 'input[placeholder*="Card number" i]'],
      E2E.paddleTestCard.number,
    );
    expect(filledNumber, "filled Paddle test card number").toBe(true);

    const filledExpiry = await fillFirstVisible(
      cardFrame,
      ['input[name="expiryDate"]', 'input[name="expiry"]', 'input[autocomplete="cc-exp"]', 'input[placeholder*="MM" i]'],
      E2E.paddleTestCard.expiry,
    );
    expect(filledExpiry, "filled Paddle test card expiry").toBe(true);

    const filledCvc = await fillFirstVisible(
      cardFrame,
      ['input[name="securityCode"]', 'input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[placeholder*="CVC" i]', 'input[placeholder*="CVV" i]'],
      E2E.paddleTestCard.cvc,
    );
    expect(filledCvc, "filled Paddle test card CVC").toBe(true);

    await fillFirstVisible(
      overlayFrame,
      ['input[name="cardholderName"]', 'input[autocomplete="cc-name"]', 'input[placeholder*="Name on card" i]'],
      E2E.paddleTestCard.holder,
    );

    const clickedPay = await clickFirstVisible(overlayFrame, [
      'button[type="submit"]:has-text("Pay")',
      'button:has-text("Pay now")',
      'button:has-text("Pay $")',
      'button[data-testid="submit-payment-button"]',
    ]);
    expect(clickedPay, "clicked Paddle Pay button").toBe(true);

    // 4. Wait for Paddle overlay to redirect to successUrl (intercepted locally).
    await expect
      .poll(() => redirectedThanksUrl, { timeout: 45_000 })
      .toBe(`https://expanpress.com/books/${E2E.houseCreatorHandle}/thanks`);

    await expect(page.getByText("Purchase complete")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Thank you, your download link is on its way by email" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Your e-book is on its way to the email you used at checkout, usually within 2 minutes. If it has not arrived within 1 hour, email support@expanpress.com and we will send it by hand.",
      ),
    ).toBeVisible();
    const backLink = page.getByRole("link", { name: /Back to ExpanPress\u2019s books/ });
    await expect(backLink).toHaveAttribute("href", `/books/${E2E.houseCreatorHandle}`);

    // 5. Fetch the real completed sandbox transaction and deliver the signed transaction.completed webhook locally.
    const sandboxTxn = await fetchSandboxTransaction(capturedTxnId, testStartedAtMs, E2E.sandboxSamplePriceId);
    const txnId = sandboxTxn?.id ?? capturedTxnId;
    expect(txnId, "captured sandbox txn_* id").toMatch(/^txn_/);

    const totalCents = sandboxTxn?.details?.totals?.total ?? "900";
    const expectedAmountUsd = Number(totalCents) / 100;
    const webhookBody = JSON.stringify({
      event_id: `evt_e2e_${Date.now()}`,
      event_type: "transaction.completed",
      occurred_at: new Date().toISOString(),
      data: {
        id: txnId,
        status: "completed",
        currency_code: sandboxTxn?.currency_code ?? "USD",
        changed_at: sandboxTxn?.changed_at ?? new Date().toISOString(),
        customer_id: sandboxTxn?.customer_id ?? undefined,
        details: {
          totals: {
            total: totalCents,
          },
        },
        custom_data: {
          ...(sandboxTxn?.custom_data ?? checkoutJson.payload.customData),
          email: E2E.sandboxBuyerEmail,
        },
        items: [
          {
            price: {
              id: E2E.sandboxSamplePriceId,
            },
          },
        ],
      },
    });
    const tsSeconds = Math.floor(Date.now() / 1000);
    const sig = signPaddleWebhook(E2E.sandboxWebhookSecret, webhookBody, tsSeconds);
    const api = await apiRequest.newContext({ baseURL: APP_URL, ignoreHTTPSErrors: true });
    try {
      const whRes = await api.post("/api/billing/webhook", {
        headers: {
          "content-type": "application/json",
          "paddle-signature": sig,
        },
        data: webhookBody,
      });
      expect(whRes.status(), "POST /api/billing/webhook status").toBe(200);
      const whJson = (await whRes.json()) as { ok: boolean };
      expect(whJson).toEqual({ ok: true });

      // 6. Verify ledger order, buyer_email_consent, captured local email, and Dub link.
      const deliveriesRes = await fetch(`${MOCK_HTTP_URL}/__deliveries`);
      expect(deliveriesRes.status).toBe(200);
      const deliveries = (await deliveriesRes.json()) as {
        orders: Array<Record<string, unknown>>;
        download_events: Array<Record<string, unknown>>;
        capturedEmails: Array<{ to: string; subject: string; text: string; html: string }>;
        capturedDubLinks: Array<{ url: string; domain: string }>;
      };

      const order = deliveries.orders.find((o) => o.sale_id === txnId);
      expect(order).toBeDefined();
      expect(order?.provider).toBe("paddle");
      expect(order?.amount_usd).toBe(expectedAmountUsd);
      expect(order?.currency).toBe("USD");
      expect(order?.buyer_email_consent).toBe(true);
      expect(order?.attribution_id).toBe("e2e_sandbox");

      expect(deliveries.capturedEmails.length).toBe(1);
      expect(deliveries.capturedEmails[0]?.to).toBe(E2E.sandboxBuyerEmail);
      expect(deliveries.capturedEmails[0]?.text).toContain("The Quiet Workshop (Sample)");

      expect(deliveries.capturedDubLinks.length).toBe(1);
      const issuedUrl = new URL(deliveries.capturedDubLinks[0]!.url);
      expect(issuedUrl.pathname).toMatch(/^\/books\/d\/[A-Za-z0-9_-]{43}$/);

      // 7. Verify delivery route HEAD (200 OK, no log) and GET (302 Found -> %PDF-).
      const headRes = await api.head(issuedUrl.pathname);
      expect(headRes.status(), "HEAD /books/d/[token] status").toBe(200);

      const dlRedirect = await api.get(issuedUrl.pathname, { maxRedirects: 0 });
      expect(dlRedirect.status(), "GET /books/d/[token] status").toBe(302);
      const signedLocation = dlRedirect.headers()["location"];
      expect(signedLocation, "Location header on /books/d/[token]").toBeTruthy();

      const pdfRes = await api.get(signedLocation!);
      expect(pdfRes.status(), "GET signed PDF status").toBe(200);
      expect(pdfRes.headers()["content-type"]).toContain("application/pdf");
      const pdfBytes = await pdfRes.body();
      expect(pdfBytes.subarray(0, 5).toString("utf8")).toBe("%PDF-");

      const afterDeliveries = (await (await fetch(`${MOCK_HTTP_URL}/__deliveries`)).json()) as {
        download_events: Array<{ event_type: string; sale_id: string }>;
      };
      expect(afterDeliveries.download_events.filter((e) => e.sale_id === txnId).map((e) => e.event_type)).toEqual([
        "link_issued",
        "download_completed",
      ]);
    } finally {
      await api.dispose();
    }
  });
});
