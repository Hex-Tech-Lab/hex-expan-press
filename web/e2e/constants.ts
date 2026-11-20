import { tmpdir } from "node:os";
import { join } from "node:path";

const mockPort = Number(process.env.E2E_MOCK_PORT || 54399);
const firmaTlsPort = Number(process.env.E2E_FIRMA_TLS_PORT || 54400);
const appPort = Number(process.env.E2E_APP_PORT || 3100);

/** Single source for every E2E port, id and timeout (no scattered magic numbers). */
export const E2E = {
  mockPort,
  /** HTTPS twin of the mock, for Firma: the app's fetchWithRelease refuses http (sealed contract). */
  firmaTlsPort,
  /** Throwaway self-signed cert, regenerated per run; trusted only by the test processes via NODE_EXTRA_CA_CERTS.
   *  Outside test-results/: Playwright wipes that directory at the start of every run. */
  tlsDir: join(tmpdir(), appPort === 3100 ? "expan-e2e-tls" : `expan-e2e-tls-${appPort}`),
  appPort,
  userId: "00000000-0000-4000-8000-0000000000e2",
  /** Creator that owns the E2E test product (products.creator_id, consents.creator_id). */
  creatorId: "00000000-0000-4000-8000-0000000000c1",
  productId: "00000000-0000-4000-8000-0000000000b1",
  /** Fixture creator with one LIVE product, so the B2C landing (/books) lists something to crawl. */
  // Underscore separators: the handle and product slug rules (settings registry, ADR 0065) allow only [a-z0-9] joined by "_".
  liveCreatorHandle: "e2e_live_creator",
  liveProductSlug: "e2e_live_book",
  liveProductId: "00000000-0000-4000-8000-0000000000b2",
  email: "e2e-creator@example.test",
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
