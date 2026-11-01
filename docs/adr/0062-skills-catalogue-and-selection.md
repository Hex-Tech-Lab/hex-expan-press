# ADR 0062: Skills catalogue and selection rules

Status: Accepted, 2026-11-02
Owner: CC (Claude Code)

## Context
`AGENTS.md` §Universal Skills Mandate requires every turn to run the matching Core and Select skills and report them. The mandate listed the skills by name but did not say when each one applies, so turns either skipped skills or ran the wrong ones. The founder asked for a full catalogue with when-to-use guidance, and for the SOP and this ADR to point to it.

## Decision
1. The catalogue lives at `docs/skills/SKILLS_CATALOGUE.md`. It is the source for when each skill applies. Update it when a skill is added, renamed, or retired.
2. Core skills run on every relevant turn. Select skills run when the change matches the trigger in the catalogue.
3. A skill that runs must be recorded in the turn's `### Skills Run & Findings` block. "Ran, nothing found" is a valid result. A skill that was not run needs a stated reason.
4. Gates that already exist stay in force: `database-sentinel` for data-layer changes, `gha-security-review` for workflow changes, `impeccable` for UI changes, `review-delta` before commit, and `pr-review-workflow` for PRs.
5. `verify` is user-only. Agents tell the founder to run it and do not claim it ran.
6. The probe source (`latency-probe/`) is versioned in this repo from 2026-11-02. Probe changes follow the same rules as any other code, and deploys to the Vercel project `expan-latency-probe` are approved per deploy.

## Consequences
- Turns record a named skill run, so a missing skill is visible.
- The catalogue will go stale unless it is updated with the skill list. Review it each quarter.
- Adds one document to read at the start of a turn that touches an unfamiliar area.

## Alternatives considered
- Keep the list only in `AGENTS.md`. Rejected: the list is too long to scan in the mandate section.
- Give every skill a trigger in its own `SKILL.md`. Rejected for now: the skills are shared from `~/.claude/skills/` and this repo does not own them.
