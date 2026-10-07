import { withSentryConfig } from "@sentry/nextjs/config";
import { join } from "node:path";
import type { NextConfig } from "next";

// Legacy-URL preservation during the phased static->Next migration.
// Directory-style URLs (trailing slash, no filename) were rewritten to static
// HTML in public/. Exact-filename URLs (privacy.html, assets) are served by
// public/ directly and need no rewrite. Sprint 16: /c/<handle> and
// /c/<handle>/<product> are real SSR app routes now — the DIR_ROUTES
// rewrites and the frozen public/c/ HTML are deleted. Trailing-slash legacy
// URLs still work via Next's automatic 308 (trailingSlash: false).

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
  // These defines apply to client, server AND edge bundles — only flags that are safe
  // everywhere belong here.
  compiler: {
    define: {
      __SENTRY_DEBUG__: false,
      // NOT __SENTRY_TRACING__: compiler.define also reaches the Sentry code bundled into
      // server + edge chunks, so it would strip server/edge tracing too. Next 16 has no
      // client-only define under Turbopack (the webpack() hook never runs there).
      __RRWEB_EXCLUDE_IFRAME__: true,
      __RRWEB_EXCLUDE_SHADOW_DOM__: true,
      __SENTRY_EXCLUDE_REPLAY_WORKER__: true,
    },
  },
  eslint: { ignoreDuringBuilds: false },
  // Sprint 15: the webhook resolves products from Supabase (resolveProductByAlias)
  // — no runtime config.*.json enumeration, so the former outputFileTracingIncludes
  // bundling of payments/config.*.json + books/*.json is gone.
  // Pin the tracing root to the repo root: keeps the tracer's workspace-root
  // detection deterministic across build environments.
  outputFileTracingRoot: join(__dirname, ".."),
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
