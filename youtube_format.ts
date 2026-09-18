// youtube_format.ts — deterministic YouTube video-format classification.
//
// Prior harvested metadata (data/db/samples/*/metadata.json) carried an
// `is_short` field that was WRONG for several items (e.g. 600-660s videos
// flagged as Shorts) — traced to no reusable, committed classification
// source existing anywhere in this repo; it was set by an untracked one-off
// script. This file is the single source of truth going forward.
//
// Rule (deterministic, no heuristics/guessing): YouTube's own Shorts
// eligibility ceiling is duration <= 183 seconds (3:03, the documented
// buffer YouTube itself applies above the nominal 3-minute/180s limit —
// see https://support.google.com/youtube/answer/10059070). Anything longer
// is definitionally not a Short. This is the ONLY signal used; no title
// keyword or `is_short` field from an external source may override it.

export const YOUTUBE_SHORTS_MAX_DURATION_SEC = 183;

export function classifyYouTubeFormat(durationSec: number): "short" | "long" {
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw new Error(`classifyYouTubeFormat: invalid duration_sec ${durationSec}`);
  }
  return durationSec <= YOUTUBE_SHORTS_MAX_DURATION_SEC ? "short" : "long";
}

export function isShort(durationSec: number): boolean {
  return classifyYouTubeFormat(durationSec) === "short";
}

// --- self-check (run directly: `node --experimental-strip-types youtube_format.ts` or via tsx) ---
function selfCheck() {
  const cases: [number, "short" | "long"][] = [
    [0, "short"],
    [32, "short"],
    [60, "short"],
    [180, "short"],
    [183, "short"],
    [184, "long"],
    [600, "long"],
    [811, "long"],
  ];
  let failures = 0;
  for (const [dur, expected] of cases) {
    const got = classifyYouTubeFormat(dur);
    if (got !== expected) {
      failures++;
      console.error(`FAIL: classifyYouTubeFormat(${dur}) = ${got}, expected ${expected}`);
    }
  }
  if (failures === 0) {
    console.log(`OK: all ${cases.length} classifyYouTubeFormat self-check cases passed`);
  } else {
    console.error(`${failures}/${cases.length} self-check cases FAILED`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  selfCheck();
}
