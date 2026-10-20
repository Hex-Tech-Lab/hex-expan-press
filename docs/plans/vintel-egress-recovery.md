# Vintel egress recovery (outline)

Steps only. Recovery order: measure, find source, fix, verify, monitor.

## Steps

1. **Measure.** Record outbound bytes per day, per hour, and per video. Take the baseline before any change.
2. **Find source.** Rank outbound traffic by route, job, and asset to find the top contributors.
3. **Fix.** Make the smallest change at the top source.
4. **Verify.** Compare the same measurement window before and after the fix.
5. **Monitor.** Keep the settings-page monitoring in place (spec below).

## Monitoring spec: Vintel settings page

- Panels: outbound bytes per day, per hour, and per video.
- Limits pause background jobs only. User access is never throttled.
- A job pause is recorded and visible on the page.
- Limit values are set by the owner and are not part of this document.
