import { tmpdir } from "node:os";
import { join } from "node:path";

/** Single source for every E2E port, id and timeout (no scattered magic numbers). */
export const E2E = {
  mockPort: 54399,
  /** HTTPS twin of the mock, for Firma: the app's fetchWithRelease refuses http (sealed contract). */
  firmaTlsPort: 54400,
  /** Throwaway self-signed cert, regenerated per run; trusted only by the test processes via NODE_EXTRA_CA_CERTS.
   *  Outside test-results/: Playwright wipes that directory at the start of every run. */
  tlsDir: join(tmpdir(), "expan-e2e-tls"),
  appPort: 3100,
  userId: "00000000-0000-4000-8000-0000000000e2",
  productId: "00000000-0000-4000-8000-0000000000b1",
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
