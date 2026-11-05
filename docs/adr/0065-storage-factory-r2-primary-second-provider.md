# 0065 — Storage factory: R2 primary, second provider, SHA-256 identity

**Status:** Proposed (the first code slice is implemented; the provider decision in D1, the counsel decision in D2, and the Upstash substrate check in D3 are open)
**Date:** 2026-11-01 (date the decision was made, not when this file was written)
**Supersedes:** The Supabase Storage source copy for `release-files` and `review-pdfs` (see Decision 1). ADR 0063 (sync freshness) stays in force for the sync path until those prefixes move.
**Superseded-by:** — (still standing)

## Context

Release files and review PDFs live in Supabase Storage, and a Cloudflare R2 mirror serves downloads through a sync script. Supabase's conditional-GET behaviour was never tested, and a recent Supabase traffic and log incident made Supabase a risk the owner wants to reduce. Live scratch-bucket tests run on 2026-11-01 showed R2 GetObject enforces `If-Match` (current ETag returns 200; stale and made-up ETags return 412 PreconditionFailed). Upstash Blob also enforces `If-Match` in the same test. The Upstash S3 endpoint resolves to a `*.r2.cloudflarestorage.com` host, which suggests Upstash runs on Cloudflare R2 underneath, but that is inferred from the hostname and not yet confirmed. Consent bundles are sealed evidence under ADR 0058 and are out of scope for this decision.

## Decision

1. **Primary store.** R2 is the primary store for `release-files` and `review-pdfs`. After cutover, the Supabase Storage copy of these two prefixes is retired, and the sync script is removed for them.
2. **Canonical identity is the SHA-256 of the bytes.** Object keys are content-addressed: `<prefix>/<sha256>.<ext>`. An overwrite is not allowed; a new version is a new key. ETags are used only for conditional requests against one provider. ETags are never compared across providers.
3. **Second provider.** A second copy is kept on a provider with a separate account, a separate payment instrument, and separate credentials. The provider choice is D1 below. Upstash Blob is the working candidate because it is already funded.
4. **Write order.** For each object: write the primary, read it back, compare SHA-256, record the result in the manifest, then write the secondary and verify it the same way. No cross-provider writes happen on the request path. A reconciler repairs any copy that is not verified.
5. **Deliverable.** An object is served only when at least one copy is verified against the manifest SHA-256. A copy that fails read-back verification is recorded as `failed` and is never served.
6. **Download route.** Reads go to the primary. On an error or 5xx, the route reads the verified secondary using the same content key. A buyer's link never shows a provider name.
7. **Credentials.** The application credential for these prefixes has put and get permissions only, with no delete. Deletes go through a separate admin path. Versioning or bucket lock is enabled on both providers where the provider supports it.
8. **Consent bundles are not moved by this ADR.** They stay on Supabase Storage until counsel decides (D2). Before that decision, a SHA-256 manifest of every sealed bundle is recorded outside both providers. The R2 sync must not touch the consent prefix.
9. **Separation test.** Each quarter, a restore drill serves one file from the secondary alone. If the drill fails, the secondary is treated as unavailable until it passes.

### Open decisions

- **D1. Second provider.** Either (a) Upstash Blob on a separate Cloudflare account, which shares a substrate with R2, or (b) a provider outside Cloudflare (for example Backblaze B2), which gives a real failure-domain separation. Choose before launch.
- **D2. Consent bundles.** Counsel sets the custody procedure and retention period. Until then, bundles stay on Supabase, and the decision carries an expiry date.
- **D3. Upstash substrate.** Confirm from Upstash's documentation or DPA whether Blob runs on Cloudflare R2 and whether Cloudflare is a listed sub-processor. The answer changes the separation argument in D1.

## Consequences / Tradeoffs

- Easier: buyers download from R2, which charges no egress. Verification is by content hash, so provider ETag behaviour no longer matters.
- Harder: every object has a manifest row, and a reconciler must run. A pending or failed copy is an operational state that someone must see, so alerting on rows stuck in `failed` is required.
- Accepted: if D1 chooses option (a), both copies share Cloudflare, and a Cloudflare-wide event takes out both. The ADR does not claim independence in that case.
- Failure modes handled by design: partial dual write (manifest state plus reconciler), divergent ETags (SHA-256 comparison), overwrite (content keys plus no-overwrite credentials), a silently replaced primary (read-back verification on reconcile demotes the copy).
- Standing rule: no code path may treat a copy as verified without a SHA-256 read-back.

## Implementation status

- Implemented: `src/adapters/storage/replica/replica-manifest.ts` (SHA-256 identity, content keys, write-and-verify, reconcile, deliverable check) with 13 unit tests against in-memory ports. Typecheck and lint are clean.
- Not yet implemented: the R2 and second-provider `ObjectCopyPort` adapters, the manifest table, the reconciler job, the download-route failover, and removal of the Supabase sync for these two prefixes. Each is blocked on D1 except the R2 adapter.

## Sources

- Live scratch-bucket test results on 2026-11-01: R2 and Upstash Blob `If-Match` behaviour (scratch buckets deleted afterward; no record kept in git).
- ADR 0058 (sealed e-sign evidence; consent bundles out of scope).
- ADR 0063 (sync freshness contract; still in force for the sync path).
- Council review of 2026-11-01 (13 advisors; the transcript is held outside git because it contains business strategy).
