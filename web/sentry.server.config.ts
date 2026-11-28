import * as Sentry from "@sentry/nextjs";
import { sentryScrubHooks } from "./src/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Real deployment environment; local runs (e.g. curl against next start) report "development".
  environment: process.env.VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  // Download tokens are bearer credentials; they must never leave the process inside an event.
  ...sentryScrubHooks,
});
