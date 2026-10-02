/** Single source for every E2E port, id and timeout (no scattered magic numbers). */
export const E2E = {
  mockPort: 54399,
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

export const MOCK_URL = `http://127.0.0.1:${E2E.mockPort}`;
export const APP_URL = `http://localhost:${E2E.appPort}`;
