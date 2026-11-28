# 0066 — Release delivery storage cascade (R2 → Upstash Blob → Supabase Storage)

**Status:** Accepted (the Upstash Blob tier is not built yet; see Decision 4)
**Date:** 2026-11-28 (founder decision in chat)
**Supersedes:** the two-tier composition in `getDeliveryStorageAdapter` (R2 then Supabase, with no written rule)
**Superseded-by:** — (still standing)

## Context

Buyer downloads are served from a signed URL for the release PDF. Cloudflare R2 is the primary store because it has no egress fees. Supabase Storage is the most expensive per download, so it must not be the primary path. Until this ADR, no document recorded the fallback order. The code composes R2 with Supabase only. On 2026-11-28 the founder asked for R2 as primary, Upstash Blob as the second tier, and Supabase as the last resort. The live test sale used the Supabase tier because no R2 variables are set on preview, and that exposed the gap.

## Decision

1. **Order is fixed.** Delivery tries, in this order: (a) primary, Cloudflare R2 presigned URL; (b) secondary, Upstash Blob signed URL; (c) tertiary, Supabase Storage signed URL. Each tier is tried only after the tier before it returns no URL.
2. **R2 serves only a verified copy.** R2 is served only when its source-ETag marker matches a fresh source listing (ADR 0063, item 9). A stale, unmarked or unverifiable R2 copy is a miss, so the cascade moves on.
3. **Supabase is the last resort.** It must stay working as a fallback, and it must be tested as one. It is not the path a healthy deployment should take.
4. **Upstash Blob is not built.** The current `getDeliveryStorageAdapter` composes R2 and Supabase only. Until an Upstash Blob adapter exists and is wired between them, the three-tier claim is not true in code. Building it is an open item, not a done item.
5. **Locations come from the settings registry.** Tier order, bucket or store names, and signed-URL lifetimes are read from `payments/src/settings_registry.ts` (`GLOBAL.delivery`), not hard-coded in adapters.
6. **Fail closed when every tier misses.** Delivery returns the existing 500 response and logs the error. It never serves an unlogged or unverified file.
7. **Storage factory, same pattern as the payment factory.** Storage connectors (`r2`, `upstash_blob`, `supabase`) are registered in one factory (`StorageFactory`, `src/adapters/storage/storage.factory.ts`). Each connector is switched on or off, and ordered into the cascade, from the settings registry (`GLOBAL.delivery.storage_connectors`: `{ name, enabled, order }`). Adding a connector means one adapter and one settings entry, with no change to route code.
8. **Name collision rule.** The storage fallback is "the storage factory's ordered fallback" in prose. It is not `pricing_tier_cascade.ts` or `provider_router.ts` (see AGENTS.md naming convention).
9. **Schedule.** The Upstash Blob connector is built after KYC and before any further storage change. Until then, decision 4 stands.

## Consequences / Tradeoffs

- **Easier:** R2 carries normal egress at zero fee, and Supabase egress is limited to misses.
- **Harder:** three stores must hold the same release bytes, and each needs its own write and freshness checks. A release published to R2 but not to Upstash makes the second tier a silent miss.
- **Accepted cost:** until Decision 4 is built, a R2 outage sends traffic straight to Supabase, the most expensive tier.
- **Standing rule:** a new release is not live until it has been written to every tier the deployment is configured for.
- **Failure mode to watch:** a tier that returns a URL for stale bytes. Decision 2 exists for this.

## Sources

- `docs/adr/0063-r2-sync-freshness-contract.md` (item 9: the download-time freshness gate that decides whether R2 is served)
- `src/adapters/storage/r2.adapter.ts` (`getDeliveryStorageAdapter` and `CompositeStorageAdapter`: today's two-tier composition)
- Founder decision in chat, 2026-11-28 (the three-tier order)
