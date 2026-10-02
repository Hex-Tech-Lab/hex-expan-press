import { defineConfig, devices } from "@playwright/test";
import { E2E, MOCK_URL, APP_URL } from "./e2e/constants";

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
      command: "pnpm exec tsx e2e/mock-supabase.ts",
      url: `${MOCK_URL}/__calls`,
      reuseExistingServer: false,
      timeout: E2E.serverStartTimeoutMs,
    },
    {
      command: `pnpm exec next dev -p ${E2E.appPort}`,
      url: `${APP_URL}/creator/signin`,
      reuseExistingServer: false,
      timeout: E2E.serverStartTimeoutMs,
      env: appEnv,
    },
  ],
});
