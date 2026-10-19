#!/usr/bin/env bash
# Skill gates for hex-yt-intel and hex-expan (docs/agent-prompts/TEMPLATE.md §3, CORE + SELECT).
# Enforcement copy: ~/.claude/hooks/skill-gates.sh must be a regular file copied from master
# (2026-10-15 owner decision), never a symlink into a checkout, so a PR cannot edit the gate it is
# judged by. Regression tests: .claude/hooks/test-skill-gates.sh.
# - git commit: advisory. Injects the required skill list for the current diff.
# - gh pr create|merge|ready and gh api .../merge: DENY unless every check below passes.
# Fail closed for PR commands: unparseable input, empty or unentered cwd, a hex target this checkout
# is not, an unrecognised hex checkout, an unresolvable base, an uncomputable diff, HEAD that is not
# the upstream (or, for a numbered PR, not the PR head), or a skill record that is missing, unproven,
# or PARTIAL/FAIL without a written waiver.
in=$(cat)
cmd=$(jq -r '.tool_input.command // ""' <<<"$in" 2>/dev/null) || cmd="$in"
cwd=$(jq -r '.cwd // ""' <<<"$in" 2>/dev/null) || cwd=""

is_commit=0; is_pr=0
# Bash accepts tabs as well as spaces between tokens, so every separator below is [[:space:]] (2026-10-15 CodeRabbit).
S='[[:space:]]'
grep -qE "(^|[;&|(\`\"'[:space:]])git(${S}+-[Cc]${S}+[^[:space:]]+|${S}+-[^[:space:]]+)*${S}+commit(${S}|\$|\")" <<<"$cmd" && is_commit=1
# Global gh options (-R/--repo, --hostname, ...) may sit between `gh` and `pr`; match them.
# Wrapped forms (env VAR=x gh ..., bash -c "gh ...", quoted command) are matched too: the gh token may follow whitespace or a quote.
grep -qE "(^|[;&|(\`\"'[:space:]])gh(${S}+-[^[:space:]]+(${S}+[^-[:space:]][^[:space:]]*)?)*${S}+pr${S}+(create|merge|ready)(${S}|\$|\")" <<<"$cmd" && is_pr=1
grep -qE "(^|[;&|(\`\"'[:space:]])gh(${S}+-[^[:space:]]+(${S}+[^-[:space:]][^[:space:]]*)?)*${S}+api${S}+[^;&|]*/merge" <<<"$cmd" && is_pr=1
[ $is_commit -eq 0 ] && [ $is_pr -eq 0 ] && exit 0

# Hand-built JSON so a missing jq cannot turn a deny into an allow.
deny(){
  local esc
  esc=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  ')
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$esc"
  exit 0
}

if [ -z "$cwd" ] || ! cd "$cwd" 2>/dev/null; then
  [ $is_pr -eq 1 ] && deny "Skill gate: cannot enter cwd '${cwd:-<empty>}' to verify the PR gates (fail closed)."
  exit 0
fi
# Honour a leading `cd <dir> &&` so gates are checked in the checkout the command targets.
lead=$(sed -nE 's/^[[:space:]]*cd[[:space:]]+("([^"]+)"|([^ ;&|]+)).*/\2\3/p' <<<"$cmd")
# Expand a leading ~ (the shell would; a literal "~/..." made cd fail and the gate silently allow -- 2026-10-12).
lead="${lead/#\~/$HOME}"
if [ -n "$lead" ] && ! cd "$lead" 2>/dev/null; then
  [ $is_pr -eq 1 ] && deny "Skill gate: 'cd $lead' failed, so the PR gates cannot be verified (fail closed)."
  exit 0
fi

top=$(git rev-parse --show-toplevel 2>/dev/null)
origin_repo=$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#.*[:/]([^/:]+/[^/]+)$#\1#')
# Explicit target repo (gh -R OWNER/NAME or --repo). It must be the repo checked out here, or the hook cannot verify it.
target=$(grep -oE -- '(-R|--repo)[ =][^ ;&|]+' <<<"$cmd" | head -1 | sed -E 's/^(-R|--repo)[ =]//')
if [ $is_pr -eq 1 ] && [ -n "$target" ] && grep -qE 'hex-(expan|yt-intel)' <<<"$target" && [ "$origin_repo" != "$target" ]; then
  deny "Skill gate: this PR command targets $target, but this checkout is '${origin_repo:-not a git checkout}'. Run it from the $target checkout (fail closed)."
fi

case "$top" in
  *hex-yt-intel*) BASE_BRANCH=origin/main; mu=$(git merge-base HEAD origin/uat 2>/dev/null); mm=$(git merge-base HEAD origin/main 2>/dev/null); [ -n "$mu" ] && [ "$mu" != "$mm" ] && git merge-base --is-ancestor "$mm" "$mu" 2>/dev/null && BASE_BRANCH=origin/uat ;;
  *hex-expan*) BASE_BRANCH=origin/master ;;
  *)
    # Not a hex checkout by path (or not a git checkout). A PR command aimed at a hex repo is denied.
    if [ $is_pr -eq 1 ] && { grep -qE 'hex-(expan|yt-intel)' <<<"$cmd" || grep -qE 'hex-(expan|yt-intel)' <<<"$origin_repo"; }; then
      deny "Skill gate: hex PR command from a checkout the gate does not recognise as hex (fail closed)."
    fi
    exit 0 ;;
esac
case "$top" in */docs/private) exit 0;; esac

if ! git rev-parse --verify -q "$BASE_BRANCH^{commit}" >/dev/null 2>&1; then
  [ $is_pr -eq 1 ] && deny "Skill gate: base $BASE_BRANCH does not resolve, so the diff cannot be computed (fail closed). Run git fetch origin."
  exit 0
fi
base=$(git merge-base HEAD "$BASE_BRANCH" 2>/dev/null)
if [ -z "$base" ]; then
  [ $is_pr -eq 1 ] && deny "Skill gate: no merge-base between HEAD and $BASE_BRANCH (fail closed)."
  exit 0
fi
committed=$(git diff --name-only "$base" HEAD 2>/dev/null) || {
  [ $is_pr -eq 1 ] && deny "Skill gate: git diff failed for $base..HEAD (fail closed)."
  exit 0
}
files=$( { printf '%s\n' "$committed"; git diff --name-only --cached 2>/dev/null; git diff --name-only 2>/dev/null; } | sort -u)

if [ $is_pr -eq 1 ]; then
  # The gate record covers HEAD. A PR command must act on exactly that commit, so HEAD must be pushed
  # (no numbered PR) or equal the numbered PR's head. gh failing or returning nothing denies.
  head_sha=$(git rev-parse HEAD 2>/dev/null)
  upstream=$(git rev-parse --verify -q '@{u}' 2>/dev/null) || upstream=""
  pr_num=$(grep -oE "(pr${S}+(merge|ready)${S}+#?[0-9]+|pulls/[0-9]+/merge)" <<<"$cmd" | grep -oE '[0-9]+' | head -1)
  api_repo=$(grep -oE 'repos/[^/ ]+/[^/ ]+/pulls/' <<<"$cmd" | head -1 | sed -E 's#^repos/##; s#/pulls/$##')
  repo_arg=${api_repo:-${target:-$origin_repo}}
  if [ -n "$pr_num" ]; then
    pr_head=$(gh pr view "$pr_num" -R "$repo_arg" --json headRefOid -q .headRefOid 2>/dev/null) || pr_head=""
    [ -n "$pr_head" ] && [ "$pr_head" = "$head_sha" ] || deny "Skill gate: PR #$pr_num head is '${pr_head:-unknown}', local HEAD is $head_sha. Push and re-record the gates for the PR head (fail closed)."
  else
    [ -n "$upstream" ] && [ "$upstream" = "$head_sha" ] || deny "Skill gate: HEAD $head_sha is not pushed to its upstream. Push first so the gates cover the PR head (fail closed)."
  fi
fi

# CORE (always) — TEMPLATE §3
# Entries prefixed agent: are pr-review-toolkit subagents (Agent tool, subagent_type pr-review-toolkit:<name>), not Skill-tool skills.
# Updated 2026-10-13 (AGY): Added verification-before-completion to enforce evidence before claims across all diffs.
req="build-graph code-reviewer simplify review-delta review-duplication runtime-verification verification-before-completion"
# qa-intel is required where its engine exists on the checkout OR on the base branch (union, so a PR cannot drop the file to skip it).
{ [ -f "$top/scripts/verify-quality-engine.ts" ] || git cat-file -e "$BASE_BRANCH:scripts/verify-quality-engine.ts" 2>/dev/null; } && req="$req qa-intel"
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
  jq -n --arg c "$GUIDE" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("Commit gate. "+$c)}}' 2>/dev/null
  exit 0
fi

gd=$(cd "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd)
[ -n "$gd" ] || deny "Skill gate: cannot locate the git dir to read the gate record (fail closed)."
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
  case "$ev_real" in "$ev_root_real"/*) ;; *) noev="$noev $s"; continue;; esac
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
if [[ "$cmd" =~ (^|[[:space:]])pr[[:space:]]+merge || "$cmd" =~ /merge ]]; then
  grep -qE '^code-review( |$)' "$marker" || missing="$missing code-review"
fi
[ -n "$missing" ] && deny "Skill gates incomplete for HEAD. Missing:${missing}. $GUIDE"
exit 0
