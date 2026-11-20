import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { E2E, MOCK_URL, MOCK_HTTP_URL, APP_URL } from "./e2e/constants";

const sandboxMode = process.env.E2E_PADDLE_SANDBOX === "1";
const sandboxClientToken = (process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "").trim();
const sandboxApiKey = (process.env.PADDLE_SANDBOX_API_KEY ?? "").trim();

if (sandboxMode) {
  if (sandboxClientToken.startsWith("live_")) {
    throw new Error("playwright.config.ts: refusing live_* Paddle client token in sandbox E2E");
  }
  if (sandboxApiKey.startsWith("pdl_live_")) {
    throw new Error("playwright.config.ts: refusing pdl_live_* Paddle API key in sandbox E2E");
  }
}

// Every env var in web/.env.local, plus every var the app reads, is set here
// (process env beats .env files in Next), so the dev server never reaches a
// real Supabase, Firma, Paddle live, Polar, Resend, Dub, Redis, or Sentry.
const appEnv: Record<string, string> = {
  SUPABASE_URL: MOCK_URL,
  SUPABASE_PUBLISHABLE_KEY: "e2e-publishable",
  SUPABASE_SECRET_KEY: "e2e-secret",
  NEXT_PUBLIC_SUPABASE_URL: MOCK_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "e2e-publishable",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-publishable",
  NEXT_PUBLIC_SITE_ORIGIN: APP_URL,
  SENTRY_DSN: "",
  NEXT_PUBLIC_SENTRY_DSN: "",
  SENTRY_ORG: "",
  SENTRY_PROJECT: "",
  SENTRY_AUTH_TOKEN: "",
  FIRMA_API_BASE: `${MOCK_URL}/firma`,
  FIRMA_API_KEY: "e2e-firma",
  ESIGN_PRIMARY_PROVIDER: "firma",
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: sandboxMode ? sandboxClientToken : "",
  NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_ENVIRONMENT: "sandbox",
  ...(sandboxMode
    ? {
        PADDLE_API_KEY: sandboxApiKey,
        PADDLE_WEBHOOK_SECRET: E2E.sandboxWebhookSecret,
        PADDLE_PRICE_MAP: JSON.stringify({ [E2E.sandboxSamplePriceId]: E2E.sandboxSampleProductId }),
        DELIVERY_LINK_KEY: process.env.DELIVERY_LINK_KEY ?? randomBytes(32).toString("base64"),
        RESEND_API_KEY: "re_e2e_mock",
        RESEND_BASE_URL: `${MOCK_HTTP_URL}/resend`,
        DUB_API_KEY: "dub_e2e_mock",
        DUB_API_BASE_URL: `${MOCK_HTTP_URL}/dub`,
        UPSTASH_REDIS_REST_URL: `${MOCK_HTTP_URL}/redis`,
        UPSTASH_REDIS_REST_TOKEN: "e2e-redis-token",
      }
    : {}),
  POLAR_CHECKOUT_URL: "",
  ALLOWED_AUTH_HOSTS: "localhost",
  NEXT_PUBLIC_ONBOARDING_ACTIVE: "true",
  // The app's server-side fetches reach the HTTPS mock; trust only this run's throwaway certificate.
  NODE_EXTRA_CA_CERTS: join(E2E.tlsDir, "cert.pem"),
};

export default defineConfig({
  testDir: "./e2e",
  timeout: E2E.testTimeoutMs,
  expect: { timeout: E2E.expectTimeoutMs },
  fullyParallel: false,
  workers: 1, // one shared in-memory mock backend
  reporter: "list",
  use: {
    baseURL: APP_URL,
    headless: true,
    launchOptions: { args: ["--disable-dev-shm-usage", "--no-sandbox"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm exec tsx e2e/tls-cert.ts && pnpm exec tsx e2e/mock-supabase.ts",
      // Readiness probe over plain HTTP (the mock's own twin port): the HTTPS mock's self-signed
      // certificate made the probe fail TLS validation and hang until the timeout.
      url: `${MOCK_HTTP_URL}/__calls`,
      reuseExistingServer: false,
      timeout: E2E.serverStartTimeoutMs,
      env: {
        E2E_MOCK_PORT: String(E2E.mockPort),
        E2E_FIRMA_TLS_PORT: String(E2E.firmaTlsPort),
        E2E_APP_PORT: String(E2E.appPort),
        ...(process.env.E2E_PADDLE_SANDBOX_PRICE_ID ? { E2E_PADDLE_SANDBOX_PRICE_ID: process.env.E2E_PADDLE_SANDBOX_PRICE_ID } : {}),
      },
    },
    {
      // E2E_PROD=1 serves the production build (run `pnpm build` first with the mock env, see the B2C runbook).
      command: process.env.E2E_PROD === "1" ? `pnpm exec next start -p ${E2E.appPort}` : `pnpm exec next dev -p ${E2E.appPort}`,
      url: `${APP_URL}/creator/signin`,
      reuseExistingServer: false,
      timeout: E2E.serverStartTimeoutMs,
      env: appEnv,
    },
  ],
});
