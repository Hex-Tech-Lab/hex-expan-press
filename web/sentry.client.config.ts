import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Real deployment environment (production / preview); local builds report "development"
  // so test traffic never lands in production alerts.
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  // Vercel's Live feedback toolbar (injected only for logged-in team members) throws its own
  // errors; never report third-party toolbar code (HEX-EXPAN-PRESS-5).
  denyUrls: [/\/_next-live\//, /vercel\.live/],
  tracesSampleRate: 0.1,
  // Wave 3: errors first, keep the footprint minimal
  sendDefaultPii: false,
});
