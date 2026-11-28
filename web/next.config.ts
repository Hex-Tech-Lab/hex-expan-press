import { withSentryConfig } from "@sentry/nextjs/config";
import { join } from "node:path";
import type { NextConfig } from "next";
// Explicit .ts so Node's native import of this config resolves the registry (ESM needs the extension).
import { GLOBAL } from "../payments/src/settings_registry.ts";

// Same pay host as proxy.ts (ADR 0061), read from the same registry value (storefront.pay_origin).
const PAY_HOST = new URL(GLOBAL.storefront.pay_origin).host;
// The build fails when the registry has no B2C landing URL: the error page must never fall back silently to "/".
if (!GLOBAL.storefront.b2c_landing_url) {
  throw new Error("settings registry: storefront.b2c_landing_url is empty; the error page needs it");
}

// Legacy-URL preservation during the phased static->Next migration.
// Directory-style URLs (trailing slash, no filename) were rewritten to static
// HTML in public/. Exact-filename URLs (privacy.html, assets) are served by
// public/ directly and need no rewrite. Sprint 16: /c/<handle> and
// /c/<handle>/<product> are real SSR app routes now — the DIR_ROUTES
// rewrites and the frozen public/c/ HTML are deleted. Trailing-slash legacy
// URLs still work via Next's automatic 308 (trailingSlash: false).

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Inlined at build time from the registry. The client error boundary (app/error.tsx) cannot import the registry, so it reads this.
  env: {
    NEXT_PUBLIC_B2C_LANDING_URL: GLOBAL.storefront.b2c_landing_url,
  },
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
  // ADR 0061: creator storefronts moved from /c/ to /books/. Old links keep working through 301s.
  // Redirects run before proxy.ts, so each one excludes the pay host (missing host condition).
  // On pay.expanpress.com these paths must reach proxy.ts and return its hard 404, not a 301.
  // Every other host (apex and www) keeps the legacy redirect.
  async redirects() {
    const notPayHost = [{ type: "host" as const, value: PAY_HOST }];
    return [
      { source: "/c/:handle", destination: "/books/:handle", statusCode: 301, missing: notPayHost },
      { source: "/c/:handle/:product", destination: "/books/:handle/:product", statusCode: 301, missing: notPayHost },
      // Buyer download route moved under /books (B2C confinement). Any /d/{token} link already sent keeps working.
      { source: "/d/:token", destination: "/books/d/:token", statusCode: 301, missing: notPayHost },
    ];
  },
  // Static assets only. The former immutable /covers rule was removed: no cover is
  // published at a fixed path, so an immutable one-year cache would serve stale covers.
  // See docs/adr/0064-remove-immutable-cover-cache.md before reinstating it.
  async headers() {
    return [
      {
        source: "/assets/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: `public, max-age=${GLOBAL.limits.static_asset_max_age_seconds}, stale-while-revalidate=${GLOBAL.limits.static_asset_stale_seconds}`,
          },
        ],
      },
      {
        source: "/books/legal/providers.html",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        source: "/legal/providers.html",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
  // Sprint 15: the webhook resolves products from Supabase (resolveProductByAlias)
  // — no runtime config.*.json enumeration, so the former outputFileTracingIncludes
  // bundling of payments/config.*.json + books/*.json is gone.
  // Storefront SSR resolves cover_image & preview_pdf from books/*.json via products.book_registry
  // (or settings_registry fallback), so bundle books/*.json with the /books/** server routes.
  outputFileTracingRoot: join(__dirname, ".."),
  outputFileTracingIncludes: {
    "/books/**": ["../books/*.json"],
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG || GLOBAL.project.sentry_org,
  project: process.env.SENTRY_PROJECT || GLOBAL.project.sentry_project,
  // Uploads are skipped silently when no token is present (local dev)
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  // v11 removed the top-level disableLogger (it was silently ignored); this is its
  // replacement for webpack builds — compiler.define above covers Turbopack.
  webpack: { treeshake: { removeDebugLogging: true } },
});
