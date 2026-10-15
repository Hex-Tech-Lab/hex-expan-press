#!/usr/bin/env bash
# Regression tests for .claude/hooks/skill-gates.sh (fail-closed rules, 2026-10-15).
# Runs the hook against throwaway repos in a mktemp dir. gh is stubbed; nothing touches the network.
# Usage: bash .claude/hooks/test-skill-gates.sh   (exits non-zero on any failure)
HOOK="$(cd "$(dirname "$0")" && pwd)/skill-gates.sh"
T=$(mktemp -d) || exit 1
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/badjq"
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stub for `gh pr view N --json headRefOid`: prints FAKE_GH_HEAD, or fails when FAKE_GH_RC is set.
[ -n "${FAKE_GH_RC:-}" ] && exit "$FAKE_GH_RC"
printf '%s\n' "${FAKE_GH_HEAD:-}"
EOF
chmod +x "$T/bin/gh"
printf '#!/usr/bin/env bash\nexit 2\n' > "$T/badjq/jq"; chmod +x "$T/badjq/jq"
export PATH="$T/bin:$PATH"

R="$T/work/hex-expan"; GD="$R/.git"
mkdir -p "$R" && git -C "$R" init -q && git -C "$R" config user.email t@t && git -C "$R" config user.name t
git -C "$R" remote add origin https://github.com/Hex-Tech-Lab/hex-expan-press.git
echo base > "$R/README.md" && git -C "$R" add -A && git -C "$R" commit -qm base
BASE_SHA=$(git -C "$R" rev-parse HEAD)
git -C "$R" update-ref refs/remotes/origin/master HEAD
git -C "$R" checkout -qb feature
echo change > "$R/docs.md" && git -C "$R" add -A && git -C "$R" commit -qm change
git -C "$R" update-ref refs/remotes/origin/feature HEAD
git -C "$R" config branch.feature.remote origin && git -C "$R" config branch.feature.merge refs/heads/feature

pass=0; fail=0; LAST=""
expect(){ # expect <name> <allow|deny|advisory> <cwd> <command>
  local out d
  out=$(jq -n --arg c "$4" --arg d "$3" '{tool_input:{command:$c},cwd:$d}' | bash "$HOOK" 2>&1)
  if grep -qE "\"permissionDecision\": ?\"deny\"" <<<"$out"; then d=deny
  elif grep -q 'additionalContext' <<<"$out"; then d=advisory
  else d=allow; fi
  LAST="$out"
  if [ "$d" = "$2" ]; then pass=$((pass+1))
  else fail=$((fail+1)); echo "FAIL: $1 (want $2, got $d): $(jq -r '.hookSpecificOutput.permissionDecisionReason // empty' <<<"$out" 2>/dev/null | cut -c1-220)"; fi
}
reason_has(){ # reason_has <name> <substring>: the last deny reason must contain the substring
  if jq -r '.hookSpecificOutput.permissionDecisionReason // empty' <<<"$LAST" 2>/dev/null | grep -qF -- "$2"; then pass=$((pass+1))
  else fail=$((fail+1)); echo "FAIL: $1 (reason lacks: $2)"; fi
}
reqlist(){ jq -r '.hookSpecificOutput.permissionDecisionReason // empty' <<<"$LAST" | sed -nE 's/.*SELECT\): ([^.]*)\..*/\1/p'; }
start_marker(){ git -C "$R" rev-parse HEAD > "$GD/skill-gates-ok"; }
record(){ # record <skill> <"PASS"|"N/A"|"waiver: reason"|"PARTIAL">
  mkdir -p "$GD/skill-gates"; local ev="$GD/skill-gates/$1.txt"
  head -c 400 /dev/zero | tr '\0' 'x' > "$ev"
  printf '%s %s evidence:%s\n' "$1" "$2" "$ev" >> "$GD/skill-gates-ok"
}

# 1. Fail closed on input the hook cannot parse.
out=$(printf 'not json: gh pr merge 5' | bash "$HOOK" 2>&1)
if grep -q '"permissionDecision":"deny"' <<<"$out"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: unparseable input with a PR command should deny"; fi
# 2. Empty cwd denies a PR command (it cannot be verified).
expect "empty cwd, PR create" deny "" "gh pr create --fill"
# 3. Unenterable cwd denies a PR command.
expect "missing cwd, PR create" deny "$T/does-not-exist" "gh pr create --fill"
# 4. Unrelated commands pass through.
expect "plain ls" allow "$R" "ls -la"
# 5. Commit is advisory, including the git -C form the old regex missed.
expect "git -C commit is advisory" advisory "$R" "git -C . commit -m x"
# 6. No gate record for HEAD: deny, and the required list is shown.
expect "PR create without a gate record" deny "$R" "gh pr create --fill"
reason_has "required list is shown" "Required skills for this diff"
REQ=$(reqlist)
# 7. HEAD not pushed: deny.
git -C "$R" update-ref -d refs/remotes/origin/feature
expect "unpushed HEAD" deny "$R" "gh pr create --fill"
reason_has "unpushed reason" "not pushed"
git -C "$R" update-ref refs/remotes/origin/feature HEAD
# 8. Base ref does not resolve: deny (old code fell back to the literal ref name).
git -C "$R" update-ref -d refs/remotes/origin/master
expect "unresolvable base" deny "$R" "gh pr create --fill"
reason_has "unresolvable base reason" "does not resolve"
git -C "$R" update-ref refs/remotes/origin/master "$BASE_SHA"
# 9. Numbered PR whose head is not local HEAD: deny.
FAKE_GH_HEAD=0000000000000000000000000000000000000000 expect "PR head differs from HEAD" deny "$R" "gh pr merge 5 --squash"
# 10. gh cannot report the PR head: deny.
FAKE_GH_RC=1 expect "gh failure on numbered PR" deny "$R" "gh pr merge 5 --squash"
# 11. Full record, all PASS: allow.
start_marker
for s in $REQ; do record "$s" PASS; done
expect "complete record allows PR create" allow "$R" "gh pr create --fill"
# 12. One skill PARTIAL with no waiver: deny.
start_marker
for s in $REQ; do record "$s" PASS; done
sed -i "s/^build-graph PASS/build-graph PARTIAL/" "$GD/skill-gates-ok"
expect "PARTIAL without waiver" deny "$R" "gh pr create --fill"
reason_has "PARTIAL reason" "PARTIAL/FAIL without waiver"
# 13. The same skill with a written waiver: allow.
sed -i "s/^build-graph PARTIAL/build-graph waiver: reviewed by hand, see notes/" "$GD/skill-gates-ok"
expect "waiver with reason allows" allow "$R" "gh pr create --fill"
# 14. Evidence that points outside the git dir: deny.
start_marker
for s in $REQ; do record "$s" PASS; done
head -c 400 /dev/zero | tr '\0' 'x' > "$T/outside.txt"
sed -i "s|^code-reviewer PASS evidence:.*|code-reviewer PASS evidence:$T/outside.txt|" "$GD/skill-gates-ok"
expect "evidence outside the git dir" deny "$R" "gh pr create --fill"
reason_has "outside-evidence reason" "no durable evidence"
# 15. Non-hex checkouts: unrelated commands allowed; a PR aimed at hex from a non-hex dir denied.
mkdir -p "$T/other" && git -C "$T/other" init -q
expect "non-hex PR create, no hex mention" allow "$T/other" "gh pr create --fill"
expect "PR aimed at hex from non-hex dir" deny "$T/other" "gh pr merge 5 -R Hex-Tech-Lab/hex-expan-press"
# 16. -R names a different hex repo than this checkout: deny.
expect "-R mismatch with origin" deny "$R" "gh -R Hex-Tech-Lab/hex-yt-intel pr merge 5"
# 17. jq broken: the raw input is still judged, so a PR command cannot slip through a parse failure.
out=$(jq -n --arg c "gh pr create --fill" --arg d "$R" '{tool_input:{command:$c},cwd:$d}' | PATH="$T/badjq:$PATH" bash "$HOOK" 2>&1)
if grep -q '"permissionDecision":"deny"' <<<"$out"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: broken jq should deny a PR command"; fi
# 18. qa-intel is required when the base branch has the engine, even if HEAD removed it.
# The base commit gets the engine file via a side branch, so the feature diff stays unchanged.
git -C "$R" checkout -q -b qa-side "$BASE_SHA" && mkdir -p "$R/scripts" && echo "// engine" > "$R/scripts/verify-quality-engine.ts" \
  && git -C "$R" add -A && git -C "$R" commit -qm engine && QA_SHA=$(git -C "$R" rev-parse HEAD)
git -C "$R" checkout -q feature
git -C "$R" update-ref refs/remotes/origin/master "$QA_SHA"
start_marker
for s in $REQ; do record "$s" PASS; done
expect "qa-intel required when base has the engine" deny "$R" "gh pr create --fill"
reason_has "qa-intel listed" "qa-intel"
git -C "$R" update-ref refs/remotes/origin/master "$BASE_SHA"

echo "skill-gates regression: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
