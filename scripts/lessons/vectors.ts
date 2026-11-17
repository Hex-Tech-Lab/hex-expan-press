/**
 * Defect-vector classifier for harvested bot findings. V1-V10 map to the vector headings in
 * cubic-lessons.md; "new" means no keyword hit. Pure: no I/O.
 */

export type Vector = "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8" | "V9" | "V10" | "new";

/**
 * Keyword heuristics for V1-V10 (see the vector headings in cubic-lessons.md). The
 * best-scoring vector wins; ties go to the lower number; no hit gives "new".
 */
const VECTOR_PATTERNS: Array<[Vector, RegExp]> = [
  ["V1", /\.md\b|readme|documentation|\bdocs?\b|out of date|outdated|drift|stale (doc|count|number)|wrong (count|number)|file:\/\/|out-of-order timestamps?/g],
  ["V2", /regex|pattern|matcher|case-insensitive|lowercase|bypass|\bescap\w*|lint rule|false negative|silence (a |the )?(rule|check|lint|guard)|whitespace|\bguard\b|exemption|suppress/g],
  ["V3", /fails?[- ](open|closed)|silent\w*|swallow\w*|reports? success|returns? success|treated as success|fallback|fall back|default to|empty catch|ignored error|\bmasks?\b/g],
  ["V4", /validat|schema|zod|untrusted|unvalidated|coerc|type[- ]check|out[- ]of[- ]range|reversed|duplicate (id|claim)|\bnan\b|model output|provider response|response body/g],
  ["V5", /secret|token|leak|redact|sentry|signed url|api key|credential|\bpii\b|expos\w* (a |the |any )?(secret|token|key|credential|signed|url)/g],
  ["V6", /\blayout\b|\brender(s|ed|ing)?\b|hydrat|transition|unmount|\bmount(s|ed)?\b|breakpoint|visual|ui state|overlap|shape switch|\bre-?render/g],
  ["V7", /registry|setting_definitions|settings key|setting key|config(uration)? key|env (var|template)|feature flag|not registered|unregistered|hard-?coded (url|origin|key|id)/g],
  ["V8", /timeout|time ?out|unbounded|\bhang\b|no deadline|\babort|indefinite|never resolves|wait(s|ing)? (forever|indefinitely)/g],
  ["V9", /shell|bash|installer|\binstall\b|quot(e|ing)|set -e|posix|argv|spaces in (path|file)|cli arg/g],
  ["V10", /unused|dead code|never called|unreachable|unwired|not wired|not (called|used|referenced)|orphan|vacuous|tautolog|always passes|inflated|100% (coverage|on empty)/g],
];

/** Hit count per vector. Exposed so every classification can be audited. */
export function vectorScores(text: string): Record<Vector, number> {
  const lower = text.toLowerCase();
  const scores = { new: 0 } as Record<Vector, number>;
  for (const [vector, pattern] of VECTOR_PATTERNS) {
    scores[vector] = lower.match(pattern)?.length ?? 0;
  }
  return scores;
}

export function classifyVector(text: string): Vector {
  const scores = vectorScores(text);
  let best: Vector = "new";
  let bestScore = 0;
  for (const [vector] of VECTOR_PATTERNS) {
    if (scores[vector] > bestScore) {
      best = vector;
      bestScore = scores[vector];
    }
  }
  return best;
}
