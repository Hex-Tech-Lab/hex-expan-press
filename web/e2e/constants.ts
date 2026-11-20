import { tmpdir } from "node:os";
import { join } from "node:path";

/** Single source for every E2E port, id and timeout (no scattered magic numbers). */
export const E2E = {
  mockPort: Number(process.env.E2E_MOCK_PORT) || 54399,
  /** HTTPS twin of the mock, for Firma: the app's fetchWithRelease refuses http (sealed contract). */
  firmaTlsPort: Number(process.env.E2E_FIRMA_TLS_PORT) || 54400,
  /** Throwaway self-signed cert, regenerated per run; trusted only by the test processes via NODE_EXTRA_CA_CERTS.
   *  Outside test-results/: Playwright wipes that directory at the start of every run. */
  tlsDir: join(tmpdir(), "expan-e2e-tls"),
  appPort: Number(process.env.E2E_APP_PORT) || 3100,
  userId: "00000000-0000-4000-8000-0000000000e2",
  /** Creator that owns the E2E test product (products.creator_id, consents.creator_id). */
  creatorId: "00000000-0000-4000-8000-0000000000c1",
  productId: "00000000-0000-4000-8000-0000000000b1",
  /** Fixture creator with one LIVE product, so the B2C landing (/books) lists something to crawl. */
  // Underscore separators: the handle and product slug rules (settings registry, ADR 0065) allow only [a-z0-9] joined by "_".
  liveCreatorHandle: "e2e_live_creator",
  liveProductSlug: "e2e_live_book",
  liveProductId: "00000000-0000-4000-8000-0000000000b2",
  /** House sample product fixture for Paddle.js sandbox Option A overlay E2E. */
  houseCreatorHandle: "expanpress_house",
  houseCreatorId: "33333333-0000-4000-8000-0000000000c2",
  sandboxSampleProductId: "33333333-0000-4000-8000-000000000002",
  sandboxSampleStoreProductId: "house_sample_the_quiet_workshop_e2e_sandbox",
  sandboxSamplePriceId: process.env.E2E_PADDLE_SANDBOX_PRICE_ID ?? "pri_01m7v59c64k3v2m8146wmn05qp",
  sandboxWebhookSecret: "whsec_e2e_paddle_sandbox_test",
  email: "e2e-creator@example.test",
  sandboxBuyerEmail: "sandbox.buyer@example.com",
  /** Paddle's official published sandbox test card (developer.paddle.com/concepts/sell/test-payment-methods). */
  paddleTestCard: {
    number: "4242 4242 4242 4242",
    expiry: "12/35",
    cvc: "100",
    holder: "Test Buyer",
    country: "United States",
    postal: "10021",
  },
  firmaRecipientId: "rcp_e2e",
  magicLinkTokenHash: "pkce_e2e_magic_link",
  /** next dev compiles each route on first hit — generous on purpose. */
  serverStartTimeoutMs: 180_000,
  testTimeoutMs: 180_000,
  expectTimeoutMs: 30_000,
} as const;

/** The mock as the app sees it: HTTPS, because the app's fetchWithRelease refuses http (sealed contract). */
export const MOCK_URL = `https://127.0.0.1:${E2E.firmaTlsPort}`;
/** The same mock over plain HTTP, for the readiness probe and the test's own calls (no TLS trust needed). */
export const MOCK_HTTP_URL = `http://127.0.0.1:${E2E.mockPort}`;
export const APP_URL = `http://localhost:${E2E.appPort}`;
