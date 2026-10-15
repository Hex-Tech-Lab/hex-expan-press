#!/usr/bin/env bash
# Skill gates for hex-yt-intel and hex-expan (docs/agent-prompts/TEMPLATE.md §3, CORE + SELECT).
# Versioned in hex-expan (2026-10-15). ~/.claude/hooks/skill-gates.sh is a symlink to this file.
# - git commit: inject the required skill list for the current diff.
# - gh pr create|merge|ready and gh api .../merge: deny unless $(git-dir)/skill-gates-ok has HEAD on
#   line 1 and one line per required skill that is PASS (or N/A) with evidence stored under
#   $(git-dir)/skill-gates/. A PARTIAL/FAIL/pending line counts only with a written "waiver:" in the line.
# Fail closed: a PR command aimed at a hex repo that this checkout cannot verify is denied.
in=$(cat); cmd=$(jq -r '.tool_input.command // ""' <<<"$in"); cwd=$(jq -r '.cwd // ""' <<<"$in")

is_commit=0; is_pr=0
grep -qE '(^|[;&|(][[:space:]]*)git (-c [^ ]+ )*commit( |$)' <<<"$cmd" && is_commit=1
# Global gh options (-R/--repo, --hostname, ...) may sit between `gh` and `pr`; match them.
# Wrapped forms (env VAR=x gh ..., bash -c "gh ...", quoted command) are matched too: the gh token may follow whitespace or a quote.
grep -qE '(^|[;&|(`"'"'"'[:space:]])gh( +-[^ ]+( +[^- ][^ ]*)?)* +pr +(create|merge|ready)( |$|")' <<<"$cmd" && is_pr=1
grep -qE '(^|[;&|(`"'"'"'[:space:]])gh( +-[^ ]+( +[^- ][^ ]*)?)* +api +[^;&|]*/merge' <<<"$cmd" && is_pr=1
[ $is_commit -eq 0 ] && [ $is_pr -eq 0 ] && exit 0

deny(){ jq -n --arg c "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$c}}'; exit 0; }

cd "$cwd" 2>/dev/null || { [ $is_pr -eq 1 ] && deny "Skill gate: cannot enter cwd '$cwd' to verify the PR gates (fail closed)."; exit 0; }
# Honour a leading `cd <dir> &&` so gates are checked in the checkout the command targets.
lead=$(sed -nE 's/^[[:space:]]*cd[[:space:]]+("([^"]+)"|([^ ;&|]+)).*/\2\3/p' <<<"$cmd")
# Expand a leading ~ (the shell would; a literal "~/..." made cd fail and the gate silently allow -- 2026-10-12).
lead="${lead/#\~/$HOME}"
if [ -n "$lead" ]; then
  cd "$lead" 2>/dev/null || { [ $is_pr -eq 1 ] && deny "Skill gate: 'cd $lead' failed, so the PR gates cannot be verified (fail closed)."; exit 0; }
fi

# Explicit target repo (gh -R OWNER/NAME or --repo). It must be the repo checked out here, or the hook cannot verify it.
if [ $is_pr -eq 1 ]; then
  target=$(grep -oE -- '(-R|--repo)[ =][^ ;&|]+' <<<"$cmd" | head -1 | sed -E 's/^(-R|--repo)[ =]//')
  if [ -n "$target" ] && grep -qE 'hex-(expan|yt-intel)' <<<"$target"; then
    origin_repo=$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#.*[:/]([^/:]+/[^/]+)$#\1#')
    [ "$origin_repo" = "$target" ] || deny "Skill gate: this PR command targets $target, but this checkout is '${origin_repo:-not a git checkout}'. Run it from the $target checkout (fail closed)."
  fi
fi

top=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$top" ]; then
  [ $is_pr -eq 1 ] && grep -qE 'hex-(expan|yt-intel)' <<<"$cmd" && deny "Skill gate: hex PR command outside a hex checkout (fail closed)."
  exit 0
fi
case "$top" in *hex-yt-intel*) BASE_BRANCH=origin/main; mu=$(git merge-base HEAD origin/uat 2>/dev/null); mm=$(git merge-base HEAD origin/main 2>/dev/null); [ -n "$mu" ] && [ "$mu" != "$mm" ] && git merge-base --is-ancestor "$mm" "$mu" 2>/dev/null && BASE_BRANCH=origin/uat ;; *hex-expan*) BASE_BRANCH=origin/master ;; *) exit 0;; esac
case "$top" in */docs/private) exit 0;; esac

base=$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null || echo "$BASE_BRANCH")
files=$( { git diff --name-only "$base" HEAD; git diff --name-only --cached; git diff --name-only; } 2>/dev/null | sort -u)

# CORE (always) — TEMPLATE §3
# Entries prefixed agent: are pr-review-toolkit subagents (Agent tool, subagent_type pr-review-toolkit:<name>), not Skill-tool skills.
# Updated 2026-10-13 (AGY): Added verification-before-completion to enforce evidence before claims across all diffs.
# Updated 2026-10-15: qa-intel is required only where its engine exists (it was unconditional before this fix).
req="build-graph code-reviewer simplify review-delta review-duplication runtime-verification verification-before-completion"
[ -f "$top/scripts/verify-quality-engine.ts" ] && req="$req qa-intel"
# SELECT by touched paths
# UI & Motion: added motion-patterns for layout/transition consistency
grep -qE '^web/(src/)?(components|hooks|app)/' <<<"$files" && req="$req react-best-practices composition-patterns web-design-guidelines motion-patterns"
# Text processing & AST: added string-reviewer and refactor-safely for parsers, reducers, and dedupe logic
grep -qE 'web/(src/)?lib/services/.*(Combiner|reduce|parser|dedupe|synthes|prompt)' <<<"$files" && req="$req string-reviewer refactor-safely"
# Test suites: added tdd to enforce red-green and negative-control verification
grep -qE '(__tests__/|\.test\.|\.spec\.)' <<<"$files" && req="$req tdd agent:pr-test-analyzer"
grep -qE '^(worker/|web/(src/)?app/api/)|ports|adapters' <<<"$files" && req="$req agent:silent-failure-hunter agent:type-design-analyzer"
grep -qE '^(worker/|web/(src/)?app/api/|web/(src/)?lib/adapters/)' <<<"$files" && grep -qE 'fetch|webhook|auth' <(git diff "$base" HEAD -- worker web/app/api web/src/app/api 2>/dev/null) && req="$req owasp-top-10 race-condition-guard"
grep -qiE 'billing|paddle|middleware|/auth/' <<<"$files" && req="$req owasp-top-10 race-condition-guard database-sentinel"
grep -qE '^supabase/migrations/|\.sql$' <<<"$files" && req="$req supabase-postgres-best-practices supabase database-sentinel"
grep -qE '^(scripts/|\.memory/|.*\.config\.|\.[a-z-]*ignore)' <<<"$files" && req="$req agent:comment-analyzer agent:pr-test-analyzer"
grep -qE '^web/(src/)?app/.*(page|route)\.tsx?$' <<<"$files" && req="$req vercel-optimize"
req=$(tr ' ' '\n' <<<"$req" | awk 'NF && !seen[$0]++' | tr '\n' ' ')
# 2026-10-13 (owner): opening/advancing a PR means the full PR skill set, each with evidence.
[ $is_pr -eq 1 ] && req="$req pr-review-workflow review-pr pr-review-toolkit:review-pr find-bugs differential-review mp-code-review code-review"

GUIDE="Required skills for this diff (TEMPLATE §3 CORE+SELECT): ${req}. Also: /pr-review-workflow to open/advance, /code-review ONCE before merge. Record: line1 = git rev-parse HEAD, then one line per skill '<skill> <PASS|N/A|waiver: reason> evidence:<abs path under \$(git rev-parse --git-dir)/skill-gates/, >=200 bytes>' in \$(git rev-parse --git-dir)/skill-gates-ok. PARTIAL/FAIL/pending lines are refused unless they carry 'waiver:'."

if [ $is_commit -eq 1 ] && [ $is_pr -eq 0 ]; then
  jq -n --arg c "$GUIDE" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("Commit gate. "+$c)}}'; exit 0
fi

gd=$(git rev-parse --git-dir 2>/dev/null); gd=$(cd "$gd" 2>/dev/null && pwd)
marker="$gd/skill-gates-ok"
ev_root="$gd/skill-gates/"
ev_root_real=$(realpath -m -- "$ev_root")
# Line 1 must be HEAD.
[ "$(head -1 "$marker" 2>/dev/null)" = "$(git rev-parse HEAD)" ] || deny "Skill gates not recorded for current HEAD. $GUIDE"
missing=""
noev=""
partial=""
for s in $req; do
  line=$(grep -E "^${s}( |$)" "$marker" | head -1)
  [ -z "$line" ] && { missing="$missing $s"; continue; }
  # A typed verdict is not proof: the line must cite evidence:<file> under the git dir holding the skill's real output.
  ev=$(grep -oE 'evidence:[^ ]+' <<<"$line" | head -1 | cut -d: -f2-)
  ev="${ev/#\~/$HOME}"
  # Canonicalize before the prefix check so "..", symlinks and relative tricks cannot leave the git dir.
  ev_real=$(realpath -m -- "$ev" 2>/dev/null) || { noev="$noev $s"; continue; }
  case "$ev_real" in "$ev_root_real"*) ;; *) noev="$noev $s"; continue;; esac
  { [ -s "$ev_real" ] && [ "$(wc -c <"$ev_real")" -ge 200 ]; } || { noev="$noev $s"; continue; }
  # 2026-10-15 (owner): the verdict is the second token and must be PASS, N/A, or "waiver:" followed by a reason.
  # Anything else (PARTIAL, FAIL, pending, unknown words, or "waiver:" appearing later in the line) is refused.
  verdict=$(awk '{print $2}' <<<"$line")
  reason=$(awk '{print $3}' <<<"$line")
  case "$verdict" in
    PASS|N/A) ;;
    "waiver:") [ -n "$reason" ] && [[ "$reason" != evidence:* ]] || partial="$partial $s" ;;
    *) partial="$partial $s" ;;
  esac
done
[ -n "$noev" ] && missing="$missing (no durable evidence >=200B under $ev_root for:$noev)"
[ -n "$partial" ] && missing="$missing (PARTIAL/FAIL without waiver:$partial)"
grep -qE '^code-review( |$)' "$marker" || { grep -qE 'gh pr merge|api [^;&|]*/merge' <<<"$cmd" && missing="$missing code-review"; }
[ -n "$missing" ] && deny "Skill gates incomplete for HEAD. Missing:${missing}. $GUIDE"
exit 0
