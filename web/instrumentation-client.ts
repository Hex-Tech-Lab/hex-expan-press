// Client-side Sentry init: App Router loads this automatically (Next 15.3+).
import "./sentry.client.config";
import * as Sentry from "@sentry/nextjs";

// App Router navigation tracing (per Sentry's Next.js guide).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
