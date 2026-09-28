import type { NextConfig } from "next";

// Legacy-URL preservation during the phased static->Next migration.
// Directory-style URLs (trailing slash, no filename) must keep serving the
// moved legacy HTML from public/. Exact-filename URLs (privacy.html, assets)
// are served by public/ directly and need no rewrite. Re-introduce real
// app/ routes in later waves and DELETE the corresponding rewrite here.
const DIR_ROUTES = [
  "/creator/signin",
  "/creator/dashboard",
  "/creator/review",
  "/creator/consents",
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
  eslint: { ignoreDuringBuilds: false },
  // The legacy billing webhook enumerates payments/config.*.json at runtime.
  // Explicitly bundle those server-only files with the function (they were
  // previously bundled only because the old NFT tracer statically resolved
  // the readdir path, which the Turbopack fix removed). Keep them OUT of
  // public/ — this ships them only inside the server function artifact.
  outputFileTracingIncludes: {
    "/api/billing/webhook": ["../payments/config.*.json"],
  },
  async rewrites() {
    return [
      { source: "/", destination: "/index.html" },
      ...DIR_ROUTES.map((route) => ({
        source: route,
        destination: `${route}/index.html`,
      })),
    ];
  },
};

export default nextConfig;
