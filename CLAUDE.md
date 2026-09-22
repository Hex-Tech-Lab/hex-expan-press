# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`CLAUDE.md` is the master document for this repo. See `AGENTS.md` in this directory — it is the authoritative, actively-maintained source of commands, architecture, **multi-agent routing rules**, data format policy, and hard-won operational quirks for this repo. Read it in full before making changes, and route any OC/AGY dispatch decision through its "Agent Routing & Roles" section, not ad hoc judgment. `data/intel/engine_thesis_handover.md` is a companion handover doc (mission, pending decisions, failure folklore) — read both before touching the pipeline.

A few things worth restating because they are easy to violate accidentally:

- This is a git repo (branch `master`, remote `origin` = `github.com/Hex-Tech-Lab/hex-expan-press`, **public**). Never commit or push without being asked. Strategic/business/legal material and anything under `data/` never goes in git (Rule #0) — check `git check-ignore <path>` before staging anything new. Sessions may also run in `.claude/worktrees/*`; a worktree contains tracked files only, so gitignored `data/` is absent there unless copied in.
- Pipeline order is fixed: `harvest` → GLM generates `candidates.json` → `score`. Never reorder or skip.
- `.env` holds live API keys — never echo or paste key values back into chat.
- Files referenced in other summaries/handoffs are not guaranteed to exist — verify with `ls`/`grep` before relying on them (e.g. no `phase4_creator_match.ts` exists as of this writing; it's a proposal, not shipped code).
- **Book pipeline is frozen Pandoc-first (ADR 0037):** `manuscript/book/manuscript.md` (content) → Pandoc → `template.typ` (layout) → Typst compile. Raw `.typ` files under `manuscript/book/` and `typst_prototype/` are **generated/prototype artifacts only** — never hand-author or Python/regex/sed-patch a compiled or layout `.typ` file directly (ADR 0038); edit `manuscript.md` or `template.typ` and recompile.
- **"Comfort Print" typographic baseline (ADR 0039), for the 55+ demographic:** 11.5pt body / 0.85em leading / 1em paragraph spacing / 68pt gutter. Any layout change to `template.typ` should preserve this baseline unless a new ADR supersedes it.
