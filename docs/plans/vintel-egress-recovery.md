# Vintel egress recovery (OUTLINE, DRAFT)

Scope note: "Vintel" appears in no repo file read here. Its identity and host are UNVERIFIED. The repo's nearest match is egress work in PR #104 (merged 2026-10-19T16:49:58Z): "egress optimization, Cloudflare R2". Source: PR list via connector. R2 adapter: `src/adapters/storage/r2.adapter.ts`.

## Steps

1. **Measure.** Bytes out per day, per hour, and per video. Baseline before any change. Source of metric: UNVERIFIED (no metrics pipeline found in repo).
2. **Find source.** Rank egress by route, job, and asset. Candidates: R2 read paths (`r2.adapter.ts`), background jobs. UNVERIFIED which dominates.
3. **Fix.** Smallest change at the top source. Options UNVERIFIED until step 2 completes.
4. **Verify.** Same measurement window, before vs. after. Pass criterion: UNVERIFIED threshold.
5. **Monitor.** Settings page spec below.

## Monitoring spec: Vintel settings page

- Panels: bytes out per day, per hour, and per video.
- Limits stop background jobs only. User access is never throttled.
- Thresholds: UNVERIFIED. Proposed: soft alert at 80% of daily budget; background-job pause at 100%.
- Job pause must be recorded and visible on the page.
- Budget values: owner decision (K.).
