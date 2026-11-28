import * as Sentry from "@sentry/nextjs";
import { sentryScrubHooks } from "./src/lib/sentry-scrub";
import { setDeliveryFailureReporter } from "../payments/src/delivery";
import { setStorageFailureReporter } from "../src/adapters/storage/r2.adapter";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Real deployment environment; local runs (e.g. curl against next start) report "development".
  environment: process.env.VERCEL_ENV ?? "development",
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  // Download tokens are bearer credentials; they must never leave the process inside an event.
  ...sentryScrubHooks,
});

// Every download and delivery fault that falls through or needs an operator reaches Sentry from here, once per server.
// Payments and the storage adapter keep no Sentry dependency of their own; they call the reporters registered here.
const captureFault = (message: string, tags: Record<string, string>): void => {
  Sentry.captureException(new Error(message), { tags });
};
setDeliveryFailureReporter(captureFault);
setStorageFailureReporter(captureFault);
