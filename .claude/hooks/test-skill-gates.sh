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
git -C "$R" update-ref refs/remotes/origin/main HEAD
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
  else fail=$((fail+1)); echo "FAIL: $1 (reason lacks: $2; got: $(jq -r '.hookSpecificOutput.permissionDecisionReason // empty' <<<"$LAST" 2>/dev/null | cut -c1-160))"; fi
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
# 4b. Tab-separated tokens are still a PR command or a commit (bash accepts tabs).
expect "tab-separated PR merge is gated" deny "$R" $'gh\tpr\tmerge 5'
expect "tab-separated git commit is advisory" advisory "$R" $'git\t-C\t.\tcommit -m x'
# 5. Commit is advisory, including the git -C form the old regex missed.
expect "git -C commit is advisory" advisory "$R" "git -C . commit -m x"
# 6. No gate record for HEAD: deny, and the required list is shown.
expect "PR create without a gate record" deny "$R" "gh pr create --fill"
reason_has "required list is shown" "Required skills for this diff"
REQ=$(reqlist)
# 6b. A leading cd (quoted path with a space, subshell) or env -C moves the gates to the target checkout (R08).
mkdir -p "$T/other dir" && ln -s "$R" "$T/other dir/repo" && ln -s "$R" "$T/other2"
expect "quoted cd with a space is gated in that dir" deny "$T" "cd '$T/other dir/repo' && gh pr create --fill"
reason_has "quoted cd reaches the target gates" "Required skills for this diff"
expect "subshell cd is gated in that dir" deny "$T" "(cd $T/other2 && gh pr merge 5)"
reason_has "subshell cd reaches the target checkout" "PR #5 head is"
expect "env -C is gated in that dir" deny "$T" "env -C $T/other2 gh pr create --fill"
reason_has "env -C reaches the target gates" "Required skills for this diff"
# 7. HEAD not pushed: deny.
git -C "$R" update-ref -d refs/remotes/origin/feature
expect "unpushed HEAD" deny "$R" "gh pr create --fill"
reason_has "unpushed reason" "not pushed"
git -C "$R" update-ref refs/remotes/origin/feature HEAD
# 8. Base ref does not resolve: deny (old code fell back to the literal ref name).
git -C "$R" update-ref -d refs/remotes/origin/main
expect "unresolvable base" deny "$R" "gh pr create --fill"
reason_has "unresolvable base reason" "does not resolve"
git -C "$R" update-ref refs/remotes/origin/main "$BASE_SHA"
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
git -C "$R" update-ref refs/remotes/origin/main "$QA_SHA"
start_marker
for s in $REQ; do record "$s" PASS; done
expect "qa-intel required when base has the engine" deny "$R" "gh pr create --fill"
reason_has "qa-intel listed" "qa-intel"
git -C "$R" update-ref refs/remotes/origin/main "$BASE_SHA"

# 19. A required line's verdict must be exactly PASS, N/A, or "waiver:" followed by a reason (second token only).
for v in "pass" "PASS:" "N/A:" "waiver:" "waiver:nope" "PARTIAL" "FAIL" "pending"; do
  start_marker
  for s in $REQ; do record "$s" PASS; done
  sed -i "s|^build-graph PASS|build-graph $v|" "$GD/skill-gates-ok"
  expect "verdict '$v' is refused" deny "$R" "gh pr create --fill"
done
start_marker
for s in $REQ; do record "$s" PASS; done
sed -i "s/^build-graph PASS/build-graph N\/A/" "$GD/skill-gates-ok"
expect "verdict N/A is accepted" allow "$R" "gh pr create --fill"
# 20. Evidence cannot escape the git dir through a symlink or "..": both canonicalize outside and are refused.
start_marker
for s in $REQ; do record "$s" PASS; done
ln -sf "$T/outside.txt" "$GD/skill-gates/link.txt"
sed -i "s|^code-reviewer PASS evidence:.*|code-reviewer PASS evidence:$GD/skill-gates/link.txt|" "$GD/skill-gates-ok"
expect "symlink inside skill-gates to an outside file is refused" deny "$R" "gh pr create --fill"
start_marker
for s in $REQ; do record "$s" PASS; done
sed -i "s|^code-reviewer PASS evidence:.*|code-reviewer PASS evidence:$GD/skill-gates/../outside.txt|" "$GD/skill-gates-ok"
expect "dot-dot evidence escaping the git dir is refused" deny "$R" "gh pr create --fill"
# 21. Every merge form requires the code-review record. Only code-review is left missing, so the reason names it alone.
start_marker
for s in $REQ; do [ "$s" = code-review ] || record "$s" PASS; done
for c in "gh pr merge 5 --squash" "gh -R Hex-Tech-Lab/hex-expan-press pr merge 5 --squash" \
  "gh api repos/Hex-Tech-Lab/hex-expan-press/pulls/5/merge -X PUT" "gh api -X PUT /repos/Hex-Tech-Lab/hex-expan-press/pulls/5/merge" \
  "env GH_TOKEN=x gh pr merge 5 --squash" "bash -c 'gh pr merge 5 --squash'" "sh -c \"gh pr merge 5 --squash\""; do
  FAKE_GH_HEAD=$(git -C "$R" rev-parse HEAD) expect "merge without code-review: $c" deny "$R" "$c"
  reason_has "code-review is the only missing record: $c" "Missing: code-review code-review."
done
start_marker
for s in $REQ; do record "$s" PASS; done
FAKE_GH_HEAD=$(git -C "$R" rev-parse HEAD) expect "merge with full record incl. code-review" allow "$R" "gh pr merge 5 --squash"

# 22-24. Base-branch resolution: origin/main first, then origin/master, and fail closed when neither resolves.
# origin/master (QA_SHA) carries the qa-intel engine; origin/main (BASE_SHA) does not. The required list differs by base.
reason_lacks(){ # reason_lacks <name> <substring>: the last deny reason must NOT contain the substring
  if jq -r '.hookSpecificOutput.permissionDecisionReason // empty' <<<"$LAST" 2>/dev/null | grep -qF -- "$2"; then fail=$((fail+1)); echo "FAIL: $1 (reason has: $2)"
  else pass=$((pass+1)); fi
}
# 22. (a) Both refs present, different commits: origin/main is the base, so qa-intel is not required.
p0=$pass; f0=$fail
git -C "$R" update-ref refs/remotes/origin/master "$QA_SHA"
if ! git -C "$R" rev-parse --verify -q refs/remotes/origin/main >/dev/null || ! git -C "$R" rev-parse --verify -q refs/remotes/origin/master >/dev/null; then
  fail=$((fail+1)); echo "FAIL: (a) setup needs both refs"
fi
start_marker
expect "(a) main wins over master: PR create without a record" deny "$R" "gh pr create --fill"
reason_lacks "(a) main wins: qa-intel not required when origin/main lacks the engine" "qa-intel"
REQ_MAIN=$(reqlist)
start_marker
for s in $REQ_MAIN; do record "$s" PASS; done
expect "(a) main wins: full record for the origin/main list allows" allow "$R" "gh pr create --fill"
echo "case (a) main wins: $((pass-p0)) passed, $((fail-f0)) failed"
# 23. (b) Only origin/master present: it is the base, and qa-intel applies because it carries the engine.
p0=$pass; f0=$fail
git -C "$R" update-ref -d refs/remotes/origin/main
git -C "$R" update-ref refs/remotes/origin/master "$QA_SHA"
start_marker
expect "(b) only master: PR create without a record" deny "$R" "gh pr create --fill"
reason_has "(b) only master: qa-intel required" "qa-intel"
REQ_MASTER=$(reqlist)
start_marker
for s in $REQ_MASTER; do [ "$s" = qa-intel ] || record "$s" PASS; done
expect "(b) only master: qa-intel missing denies" deny "$R" "gh pr create --fill"
reason_has "(b) only master: qa-intel is the missing record" "Missing: qa-intel"
record qa-intel PASS
expect "(b) only master: qa-intel recorded allows" allow "$R" "gh pr create --fill"
echo "case (b) only master: $((pass-p0)) passed, $((fail-f0)) failed"
# 24. (c) Neither ref present: the hook fails closed even with a complete record.
p0=$pass; f0=$fail
git -C "$R" update-ref -d refs/remotes/origin/master
git -C "$R" rev-parse --verify -q refs/remotes/origin/main >/dev/null && { fail=$((fail+1)); echo "FAIL: (c) setup expects origin/main absent"; }
start_marker
for s in $REQ; do record "$s" PASS; done
expect "(c) neither base ref: PR create fails closed" deny "$R" "gh pr create --fill"
reason_has "(c) neither: base does not resolve" "does not resolve"
git -C "$R" update-ref refs/remotes/origin/main "$BASE_SHA"
git -C "$R" update-ref -d refs/remotes/origin/master 2>/dev/null || true
echo "case (c) neither ref: $((pass-p0)) passed, $((fail-f0)) failed"

echo "skill-gates regression: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
