import { withSentryConfig } from "@sentry/nextjs/config";
import { join } from "node:path";
import type { NextConfig } from "next";

// Legacy-URL preservation during the phased static->Next migration.
// Directory-style URLs (trailing slash, no filename) must keep serving the
// moved legacy HTML from public/. Exact-filename URLs (privacy.html, assets)
// are served by public/ directly and need no rewrite. Re-introduce real
// app/ routes in later waves and DELETE the corresponding rewrite here.
// Wave 5: /creator/signin is now a real app route — rewrite removed.
// Wave 6.1: /creator/review + /creator/consents are real app routes —
// rewrites removed, legacy HTML deleted.
const DIR_ROUTES = [
  "/c/retirearly500k",
  "/c/retirearly500k/500k-playbook",
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // trailingSlash stays FALSE: /api/* webhook endpoints are called with exact
  // no-slash URLs registered at external providers (Firma, Polar). With true,
  // those POSTs 308-redirect to a slash variant and webhook senders that do
  // not follow redirects break. Legacy page URLs with trailing slashes get a
  // one-hop 308 to the no-slash form, then the rewrite serves the same HTML.
  trailingSlash: false,
  typescript: { ignoreBuildErrors: false },
  // Sentry bundle trimming (Wave 8.2). @sentry/nextjs v11 applies its treeshake
  // flags via webpack DefinePlugin only, which Turbopack (Next 16's builder) never
  // runs — so the same compile-time constants are defined here, where both
  // bundlers honour them. Replay is not enabled (no replayIntegration in
  // sentry.client.config.ts); these drop its residual code paths and SDK debug logging.
  compiler: {
    define: {
      __SENTRY_DEBUG__: false,
      // Browser performance tracing off: errors are still captured, but client-side
      // traces stop (tracesSampleRate in sentry.client.config.ts becomes inert).
      __SENTRY_TRACING__: false,
      __RRWEB_EXCLUDE_IFRAME__: true,
      __RRWEB_EXCLUDE_SHADOW_DOM__: true,
      __SENTRY_EXCLUDE_REPLAY_WORKER__: true,
    },
  },
  eslint: { ignoreDuringBuilds: false },
  // The legacy billing webhook enumerates payments/config.*.json at runtime.
  // Explicitly bundle those server-only files with the function (they were
  // previously bundled only because the old NFT tracer statically resolved
  // the readdir path, which the Turbopack fix removed). Keep them OUT of
  // public/ — this ships them only inside the server function artifact.
  // Pin the tracing root to the repo root: payments/config.*.json included
  // below lives OUTSIDE web/ (the project dir). Without an explicit root the
  // tracer's workspace-root detection can vary by build environment and drop
  // out-of-project files from the serverless artifact.
  outputFileTracingRoot: join(__dirname, ".."),
  outputFileTracingIncludes: {
    "/api/billing/webhook": ["../payments/config.*.json"],
  },
  async rewrites() {
    return [
      // "/" is served by app/page.tsx since Wave 3 — no rewrite needed.
      ...DIR_ROUTES.map((route) => ({
        source: route,
        destination: `${route}/index.html`,
      })),
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG || "hex-org",
  project: process.env.SENTRY_PROJECT || "hex-expan-press",
  // Uploads are skipped silently when no token is present (local dev)
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  // v11 removed the top-level disableLogger (it was silently ignored); this is its
  // replacement for webpack builds — compiler.define above covers Turbopack.
  webpack: { treeshake: { removeDebugLogging: true } },
});
