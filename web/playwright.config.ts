import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E, MOCK_URL, MOCK_HTTP_URL, APP_URL } from "./e2e/constants";

// Fresh throwaway TLS cert for the Firma mock. The app's Firma client only
// dials https (sealed contract), so the test process trusts this cert alone.
const tlsDir = E2E.tlsDir;
mkdirSync(tlsDir, { recursive: true });
const tlsCert = path.join(tlsDir, "cert.pem");
execFileSync(
  "openssl",
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", path.join(tlsDir, "key.pem"), "-out", tlsCert],
  { stdio: "ignore" },
);

// Every env var in web/.env.local, plus every var the app reads, is set here
// (process env beats .env files in Next), so the dev server never reaches a
// real Supabase, Firma, Paddle, Polar or Sentry.
const appEnv: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: tlsCert,
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
  FIRMA_API_BASE: `https://127.0.0.1:${E2E.firmaTlsPort}/firma`,
  FIRMA_API_KEY: "e2e-firma",
  FIRMA_WEBHOOK_SECRET: "e2e-firma-webhook",
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
    ignoreHTTPSErrors: true, // the mock's self-signed cert, for browser-side calls only
    headless: true,
    launchOptions: { args: ["--disable-dev-shm-usage", "--no-sandbox"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm exec tsx e2e/mock-supabase.ts",
      url: `${MOCK_HTTP_URL}/__calls`,
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
