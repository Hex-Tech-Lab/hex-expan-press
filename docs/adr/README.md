# Architecture Decision Records

The public decision log for ExpanPress in the Next.js App Router era (Wave 6 onward).
Each ADR records one decision: its context, the choice made, and its consequences.
New ADRs use [`TEMPLATE.md`](TEMPLATE.md) and take the next free number.

Status values: `Accepted` and `Proposed` are the ADR's own status. `On branch` means the ADR exists on a public
branch but is not yet merged to `main`, so it has no file here. `Private` means the ADR is held in a private
register; only its number and title are listed.

## Published ADRs

| ADR | Title |
|---|---|
| [0053](0053-nextjs-app-router-migration.md) | Next.js App Router migration |
| [0054](0054-ssr-pkce-auth-and-middleware-refresh.md) | SSR PKCE auth and middleware token-refresh boundary |
| [0055](0055-edge-node-runtime-boundary.md) | Edge / Node.js runtime boundary |
| [0056](0056-tactile-neo-minimalism-design-system.md) | Tactile Neo-Minimalism design system |
| [0057](0057-webhook-idempotency-and-fail-closed.md) | Webhook idempotency and fail-closed financial writes |
| [0058](0058-zero-trust-esign-evidence-pipeline.md) | Zero-trust e-sign evidence pipeline (DNS-pinned SSRF defense) |
| [0059](0059-idempotent-ssr-retries.md) | Idempotent-only skew retries in Supabase SSR clients |
| [0060](0060-universal-consent-enforcement.md) | Universal consent enforcement at edge and action boundaries |
| [0061](0061-payment-domain-pay-subdomain.md) | Dedicated payment domain: pay.expanpress.com as the sole provider-agnostic checkout origin |

## Written but not yet merged to main

These files exist on public branches. Numbers 0062, 0064 and 0065 are each claimed by more than one ADR; the
owner must resolve the numbering before merge.

| ADR | Title | Status | Branch |
|---|---|---|---|
| 0062 | Database schema and access model | On branch (Accepted) | `chore/db-access-model` |
| 0062 | Payment rail launch switch: rails stay defined, enabled by settings | On branch (Accepted) | `feat/restore-polar-off` |
| 0062 | Skills catalogue and selection rules | On branch (Accepted) | `feat/latency-probe-source` |
| 0063 | R2 sync freshness and overwrite contract | On branch (Accepted) | `fix/r2-sync-freshness` |
| 0064 | Remove the immutable cover cache rule | On branch (Accepted) | `fix/r2-sync-freshness` |
| 0065 | Storage factory: R2 primary, second provider, SHA-256 identity | On branch (Proposed) | local `feat/storage-factory` only |

## Private ADRs

Held in a private register. Content is not published.

| ADR | Title | Status |
|---|---|---|
| 0001 | Pipeline architecture standards | Private |
| 0002 | Vs scoring design | Private |
| 0003 | ideabrowser.com integration deferred | Private |
| 0004 | Decodo is three separate products | Private |
| 0005 | Product direction: B2B2C SaaS, manual operator MVP first | Private |
| 0006 | vIntel separation | Private |
| 0007 | Asset generation policy | Private |
| 0008 | Summit capture ops | Private |
| 0009 | Candidate schema expansion: creator-shelf class and price band | Private |
| 0010 | Creator discovery: hard filters enforced in code | Private |
| 0011 | Trend-driven niche selection | Private |
| 0012 | Registry layer: two-file design | Private |
| 0013 | Scheduled creator-scan cadence | Private |
| 0014 | Repo is public on GitHub; secrets and strategy stay gitignored | Private |
| 0015 | Market sizing is empirical bottom-up | Private |
| 0016 | Asset-generation architecture: three-part system | Private |
| 0017 | Candidate-selection scoring | Private |
| 0018 | PDF rendering engine: Typst primary | Private |
| 0019 | vIntel access: shared-Enterprise-user auth workaround | Private |
| 0020 | Monetization cross-check trio | Private |
| 0021 | Ebook template skeletons | Private |
| 0022 | Two-layer template approach | Private |
| 0023 | flagged_outgrown tier | Private |
| 0024 | OpenCode dispatch safety | Private |
| 0025 | Instagram verification vendor | Private |
| 0026 | Creator-understanding sampling methodology | Private |
| 0027 | Persona-profile-first methodology | Private |
| 0028 | Payment-rail cascade and mandatory multi-rail policy | Private |
| 0029 | Payments layer architecture | Private |
| 0030 | Domain architecture: single domain, URL subpaths per creator | Private |
| 0031 | STT standard | Private |
| 0032 | LLM Council standard | Private |
| 0033 | Settings-registry centralization | Private |
| 0034 | OpenRouter model governance | Private |
| 0035 | Generate, Verify, Certify, Deliver gates | Private |
| 0036 | Two-track content model | Private |
| 0037 | Pandoc-first workflow for the book pipeline | Private |
| 0038 | No Python/regex/sed surgery on Typst | Private |
| 0039 | "Comfort Print" typographic standard | Private |
| 0040 | Frozen tech stack, exact-pinned | Private |
| 0041 | Book factory folder map | Private |
| 0042 | Shared Upstash Redis instance | Private |
| 0043 | Book design system as rules-as-code, with a QA gate | Private |
| 0044 | Literary Quality Gate | Private |
| 0045 | Creator profile: dual anchor | Private |
| 0046 | Creator review and release | Private |
| 0047 | Book Quality Engine | Private |
| 0048 | Creator review and sign-off portal | Private |
| 0049 | Hexagonal Lite provider architecture | Private |
| 0050 | Universal Payment Language and Zod SSOT | Private |
| 0051 | Asset security, watermarking, and provenance fingerprinting | Private |
| 0052 | Creator portal execution and consent governance | Private |
| 0064 | Local HS256 JWT verification on the portal read path | Private (draft) |
| 0065 | Generation-keyed buyer download links | Private (draft) |
| 0066 | Cloudflare R2 for buyer release delivery | Private (draft) |

No ADR exists for 0067-0070.
