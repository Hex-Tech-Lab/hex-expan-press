# <number> — <Decision title in a few words>

**Status:** Proposed | Accepted | Superseded (by ADR-XXXX)
**Date:** YYYY-MM-DD (date the decision was made, not when this file was written)
**Supersedes:** <ADR number/title, or the prior practice it replaces — omit if none>
**Superseded-by:** <ADR number, or — if still standing>

## Context

What was the situation, the forcing function, and the constraints? Two to six sentences. Name
the live evidence (verified incidents, user statements, failed attempts) — not the full research
narrative, which lives in `data/intel/`.

## Decision

What was decided, stated as enforceable rules ("always", "never", "only"). Number multi-part
decisions. Include the exact parameters/values where they were locked (thresholds, model IDs,
file paths, split percentages). If part of the decision is still unimplemented, say so
explicitly here rather than hiding it in Consequences.

## Consequences / Tradeoffs

What becomes easier, what becomes harder, what is deliberately accepted as a cost. Include
standing rules the decision created and known failure modes to watch for.

## Sources

- `data/intel/<source-doc>.md` (§section — what it contributed)
- (one bullet per source doc that carried the decision; the research narrative stays there)
