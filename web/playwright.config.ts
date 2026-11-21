import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { E2E, MOCK_URL, MOCK_HTTP_URL, APP_URL } from "./e2e/constants";

// Every env var in web/.env.local, plus every var the app reads, is set here
// (process env beats .env files in Next), so the dev server never reaches a
// real Supabase, Firma, Paddle, Polar or Sentry.
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
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "",
  NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
  POLAR_CHECKOUT_URL: "",
  ALLOWED_AUTH_HOSTS: "localhost",
  NEXT_PUBLIC_ONBOARDING_ACTIVE: "true",
  E2E_PROXY_HOST_OVERRIDE: "1",
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
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--disable-dev-shm-usage", "--no-sandbox"] },
      },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
  webServer: [
    {
      command: "pnpm exec tsx e2e/tls-cert.ts && pnpm exec tsx e2e/mock-supabase.ts",
      // Readiness probe over plain HTTP (the mock's own twin port): the HTTPS mock's self-signed
      // certificate made the probe fail TLS validation and hang until the timeout.
      url: `${MOCK_HTTP_URL}/__calls`,
      reuseExistingServer: false,
      timeout: E2E.serverStartTimeoutMs,
    },
    {
      // E2E_PROD=1 serves the production build (run `pnpm build` first with the mock env, see the B2C runbook).
      command: process.env.E2E_PROD === "1" ? `pnpm exec next start -p ${E2E.appPort}` : `pnpm exec next dev -p ${E2E.appPort}`,
      url: `${APP_URL}/creator/signin`,
      reuseExistingServer: false,
      timeout: E2E.serverStartTimeoutMs,
      // Test-only: enables the /__e2e/proxy-host probe that test (d) in e2e/b2c-confinement.spec.ts needs. The flag is necessary but not sufficient: test (d) stays skipped until the probe reports the effective host. proxy.ts also
      // requires NODE_ENV !== "production", so this flag is inert in the E2E_PROD=1 build.
      env: { ...appEnv, E2E_PROXY_HOST_DIAGNOSTIC: "1" },
    },
  ],
});
