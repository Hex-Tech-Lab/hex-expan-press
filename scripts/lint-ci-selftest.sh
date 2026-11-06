#!/usr/bin/env bash
# Self-test for .github/workflows/lint-ci.yml. Extracts each job's run block from the workflow and runs it
# against scratch repositories with planted failures and clean changes, for both the pull_request_target path
# and the push path. Each case must exit with its expected code. Needs actionlint, shellcheck, gitleaks and ruff
# on PATH at the versions the workflow pins. Run from the repo root.
# It executes the run blocks of THIS checkout's workflow file, so run it only from a trusted checkout: the push job
# on master. Never run it on a PR head, because that would execute shell written in the PR. The scratch repositories
# it builds hold the planted cases; it does not read the PR.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WF="$ROOT/.github/workflows/lint-ci.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RT="$WORK/runner"
mkdir -p "$RT"

for tool in actionlint shellcheck gitleaks ruff; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

# Pull one job step's run block out of the workflow, with the 10-space YAML indent removed.
extract() {
  awk -v name="$1" '
    index($0, "- name: " name) { f = 1; next }
    f && /^        run: \|/ { r = 1; next }
    r && /^      - / { exit }
    r && /^  [a-z]+:/ { exit }
    r { print }' "$WF" | sed 's/^          //' > "$RT/$2.sh"
  # A renamed step extracts to an empty file, which bash -n accepts and the clean cases would then pass vacuously.
  [ -s "$RT/$2.sh" ] || { echo "extract: no run block found for step '$1'" >&2; exit 2; }
  bash -n "$RT/$2.sh"
}
extract "Run actionlint on the PR's workflow files" al
extract "Scan new commits for secrets" gl
extract "Lint Python files changed by this change" ru

# A scratch repo: master has a gitleaks config, one clean Python file and one workflow.
# Prints the base SHA on stdout; the feature branch is created at the caller's directory.
make_repo() {
  local dir="$WORK/$1"
  mkdir -p "$dir"
  git init -q --bare "$dir/origin.git"
  git init -q -b master "$dir/pr"
  (
    cd "$dir/pr"
    git config user.email selftest@example.invalid
    git config user.name selftest
    mkdir -p .github/security .github/workflows
    printf '[extend]\nuseDefault = true\n' > .github/security/gitleaks.toml
    printf 'name: base\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n' > .github/workflows/base.yml
    echo 'x = 1' > ok.py
    git add -A && git commit -qm base
    git remote add origin ../origin.git
    git push -q origin master
    git rev-parse HEAD > "$dir/base.sha"
    git checkout -qb feat
  )
}

# Commit the caller's change in the scratch repo and print the head SHA.
commit_change() {
  (
    cd "$WORK/$1/pr"
    git add -A && git commit -qm "$2" && git rev-parse HEAD
  )
}

# Run one job script. $1 = repo name, $2 = job script, $3 = event, $4 = base sha, $5 = head sha.
run_job() {
  local gw="$WORK/gw-$1-$2-$3"
  mkdir -p "$gw"
  ln -sfn "$WORK/$1/pr" "$gw/pr"
  local out="$WORK/out-$1-$2-$3.txt"
  set +e
  (
    export GITHUB_WORKSPACE="$gw" RUNNER_TEMP="$RT" EVENT_NAME="$3" BASE_REF=master
    export BEFORE_SHA="$4" HEAD_SHA="$5"
    bash "$RT/$2.sh"
  ) > "$out" 2>&1
  local code=$?
  set -e
  echo "$code" > "$out.exit"
  cat "$out"
  return "$code"
}

FAILED=0
# check <label> <expected-exit> <repo> <job> <event> <base> <head>
check() {
  local label="$1" want="$2" repo="$3" job="$4" event="$5" base="$6" head="$7"
  local got=0
  run_job "$repo" "$job" "$event" "$base" "$head" > /dev/null 2>&1 || got=$?
  if [ "$got" = "$want" ]; then
    echo "PASS  $label (exit $got)"
  else
    echo "FAIL  $label (want $want, got $got)"
    FAILED=1
  fi
}

# check_leak: a "must catch" gitleaks case. Exit 1 alone is not enough, because gitleaks also exits 1 on a scan
# error. The run must also print gitleaks' leak summary, so a broken gl command cannot pass these cases.
check_leak() {
  check "$@"
  local out="$WORK/out-$3-$4-$5.txt"
  if [ "$(cat "$out.exit" 2>/dev/null)" = "1" ] && ! grep -q 'leaks found:' "$out" 2>/dev/null; then
    echo "FAIL  $1 (exit 1 without gitleaks 'leaks found:' summary: scan error, not a detection)"
    FAILED=1
  fi
}

# Fake credential: the shape gitleaks' GitHub token rule matches. Not a real credential.
# Assembled from parts so the literal prefix never sits in this file, or the repo's own secret scan would flag it.
FAKE_CRED="$(printf '%s_%s' ghp 0123456789abcdefghijklmnopqrstuvwxyz)"
ZERO="0000000000000000000000000000000000000000"

# PR path (pull_request_target): BEFORE_SHA is unused, the base comes from origin/master.
make_repo pr-token
printf 'token = "%s"\n' "$FAKE_CRED" > "$WORK/pr-token/pr/leak.txt"
H=$(commit_change pr-token "planted token")
check_leak "PR planted token -> gitleaks" 1 pr-token gl pull_request_target "$ZERO" "$H"

make_repo pr-unused
printf 'import os\nimport sys\n' > "$WORK/pr-unused/pr/bad.py"
H=$(commit_change pr-unused "unused import")
check "PR unused import -> ruff" 1 pr-unused ru pull_request_target "$ZERO" "$H"

make_repo pr-broken
printf 'name: x\non: [\n' > "$WORK/pr-broken/pr/.github/workflows/broken.yml"
H=$(commit_change pr-broken "broken workflow")
check "PR broken workflow -> actionlint" 1 pr-broken al pull_request_target "$ZERO" "$H"

# actionlint runs ShellCheck on each run block. An unquoted expansion is a real ShellCheck finding (SC2086).
make_repo pr-shellcheck
# shellcheck disable=SC2016  # the $f is written into the fixture on purpose; it must stay unexpanded
printf 'name: sc\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          f="a b"\n          echo $f\n' > "$WORK/pr-shellcheck/pr/.github/workflows/sc.yml"
H=$(commit_change pr-shellcheck "shellcheck violation")
check "PR run block with a ShellCheck violation -> actionlint fails" 1 pr-shellcheck al pull_request_target "$ZERO" "$H"

make_repo pr-symlink
TARGET="$WORK/runner-target.txt"
printf 'SELFTEST_MARKER = "must-not-appear"\n' > "$TARGET"
ln -s "$TARGET" "$WORK/pr-symlink/pr/evil.py"
H=$(commit_change pr-symlink "planted symlink")
check "PR .py symlink to a file outside the checkout -> ruff fails" 1 pr-symlink ru pull_request_target "$ZERO" "$H"
if grep -q "must-not-appear" "$WORK/out-pr-symlink-ru-pull_request_target.txt"; then
  echo "FAIL  PR symlink: target contents reached the ruff output"
  FAILED=1
else
  echo "PASS  PR symlink: target contents absent from ruff output"
fi
# The exit 1 above must come from linting the link as text, not from following it. Ruff names the linted file in its
# output, so the link's own name must appear. Without this, a parse failure of the link text could pass for the wrong reason.
if grep -q "evil.py" "$WORK/out-pr-symlink-ru-pull_request_target.txt"; then
  echo "PASS  PR symlink: ruff linted evil.py itself (the link text, not its target)"
else
  echo "FAIL  PR symlink: ruff output does not name evil.py, so the failure reason is unproven"
  FAILED=1
fi

# A symlinked .github directory must fail closed: actionlint cannot list .github/workflows at the head.
make_repo pr-gh-symlink
OUT_GH="$WORK/outside-gh"
mkdir -p "$OUT_GH/workflows"
printf 'name: outside\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n' > "$OUT_GH/workflows/outside.yml"
rm -rf "$WORK/pr-gh-symlink/pr/.github"
ln -s "$OUT_GH" "$WORK/pr-gh-symlink/pr/.github"
H=$(commit_change pr-gh-symlink "planted .github symlink")
check "PR .github is a symlink to a directory outside the checkout -> actionlint fails closed" 1 pr-gh-symlink al pull_request_target "$ZERO" "$H"
# Exit 1 alone could come from anything. The fail-closed message must be the reason.
if grep -q "cannot list .github/workflows" "$WORK/out-pr-gh-symlink-al-pull_request_target.txt"; then
  echo "PASS  PR .github symlink: failed on the fail-closed listing message"
else
  echo "FAIL  PR .github symlink: the fail-closed message is missing, so the reason is unproven"
  FAILED=1
fi

# A workflow file that is a symlink: actionlint's copy lists the tree with git ls-tree and skips any entry whose
# mode is not a regular file (120000 is a symlink), so the target's contents must not be read or printed.
make_repo pr-wf-symlink
WF_TARGET="$WORK/runner-wf-target.yml"
# The target is invalid YAML on purpose: if the copy followed the link, actionlint would fail here, so a regression
# that follows the link cannot pass this case.
printf 'name: SELFTEST_MARKER_WF\non: [\n' > "$WF_TARGET"
ln -s "$WF_TARGET" "$WORK/pr-wf-symlink/pr/.github/workflows/evil.yml"
H=$(commit_change pr-wf-symlink "planted workflow symlink")
check "PR workflow symlink to a file outside the checkout -> actionlint skips it" 0 pr-wf-symlink al pull_request_target "$ZERO" "$H"
if grep -q "SELFTEST_MARKER_WF" "$WORK/out-pr-wf-symlink-al-pull_request_target.txt"; then
  echo "FAIL  PR workflow symlink: target contents reached the actionlint output"
  FAILED=1
else
  echo "PASS  PR workflow symlink: target contents absent from actionlint output"
fi

make_repo pr-clean
printf 'import os\n\nprint(os.sep)\n' > "$WORK/pr-clean/pr/ok.py"
printf 'name: y\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n' > "$WORK/pr-clean/pr/.github/workflows/clean.yml"
H=$(commit_change pr-clean "clean change")
check "PR clean -> gitleaks" 0 pr-clean gl pull_request_target "$ZERO" "$H"
check "PR clean -> ruff" 0 pr-clean ru pull_request_target "$ZERO" "$H"
check "PR clean -> actionlint" 0 pr-clean al pull_request_target "$ZERO" "$H"

# Push path: BEFORE_SHA is the previous tip, so the range is before..head.
make_repo push-token
BASE=$(cd "$WORK/push-token/pr" && git rev-parse master)
printf 'token = "%s"\n' "$FAKE_CRED" > "$WORK/push-token/pr/leak.txt"
H=$(commit_change push-token "push planted token")
check_leak "push planted token -> gitleaks (range before..head)" 1 push-token gl push "$BASE" "$H"

make_repo push-unused
BASE=$(cd "$WORK/push-unused/pr" && git rev-parse master)
printf 'import os\nimport sys\n' > "$WORK/push-unused/pr/bad.py"
H=$(commit_change push-unused "push unused import")
check "push unused import -> ruff (range before..head)" 1 push-unused ru push "$BASE" "$H"

make_repo push-clean
BASE=$(cd "$WORK/push-clean/pr" && git rev-parse master)
printf 'import os\n\nprint(os.sep)\n' > "$WORK/push-clean/pr/ok.py"
printf 'name: y\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n' > "$WORK/push-clean/pr/.github/workflows/clean.yml"
H=$(commit_change push-clean "push clean change")
check "push clean -> gitleaks" 0 push-clean gl push "$BASE" "$H"
check "push clean -> ruff" 0 push-clean ru push "$BASE" "$H"
check "push clean -> actionlint" 0 push-clean al push "$BASE" "$H"

# Push-path symlinks: the same guards as the PR path, exercised with BEFORE_SHA..HEAD as the range.
make_repo push-symlink-py
BASE=$(cd "$WORK/push-symlink-py/pr" && git rev-parse master)
TARGET="$WORK/push-runner-target.py"
printf 'SELFTEST_MARKER = "must-not-appear"\n' > "$TARGET"
ln -s "$TARGET" "$WORK/push-symlink-py/pr/evil.py"
H=$(commit_change push-symlink-py "push planted Python symlink")
check "push .py symlink -> ruff lints link text" 1 push-symlink-py ru push "$BASE" "$H"
if grep -q "must-not-appear" "$WORK/out-push-symlink-py-ru-push.txt" ||
   ! grep -q "evil.py" "$WORK/out-push-symlink-py-ru-push.txt"; then
  echo "FAIL  push .py symlink: target was read or evil.py was not linted"
  FAILED=1
else
  echo "PASS  push .py symlink: ruff linted evil.py, not its target"
fi

make_repo push-gh-symlink
BASE=$(cd "$WORK/push-gh-symlink/pr" && git rev-parse master)
OUT_GH="$WORK/push-outside-gh"
mkdir -p "$OUT_GH/workflows"
printf 'name: outside\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n' > "$OUT_GH/workflows/outside.yml"
rm -rf "$WORK/push-gh-symlink/pr/.github"
ln -s "$OUT_GH" "$WORK/push-gh-symlink/pr/.github"
H=$(commit_change push-gh-symlink "push planted .github symlink")
check "push .github symlink -> actionlint fails closed" 1 push-gh-symlink al push "$BASE" "$H"
if grep -q "cannot list .github/workflows" "$WORK/out-push-gh-symlink-al-push.txt"; then
  echo "PASS  push .github symlink: failed on the fail-closed listing message"
else
  echo "FAIL  push .github symlink: the fail-closed message is missing, so the reason is unproven"
  FAILED=1
fi

make_repo push-wf-symlink
BASE=$(cd "$WORK/push-wf-symlink/pr" && git rev-parse master)
WF_TARGET="$WORK/push-runner-wf-target.yml"
printf 'name: SELFTEST_MARKER_WF\non: [\n' > "$WF_TARGET"
ln -s "$WF_TARGET" "$WORK/push-wf-symlink/pr/.github/workflows/evil.yml"
H=$(commit_change push-wf-symlink "push planted workflow symlink")
check "push workflow symlink -> actionlint skips it" 0 push-wf-symlink al push "$BASE" "$H"
if grep -q "SELFTEST_MARKER_WF" "$WORK/out-push-wf-symlink-al-push.txt"; then
  echo "FAIL  push workflow symlink: target contents reached actionlint"
  FAILED=1
else
  echo "PASS  push workflow symlink: target contents were not read"
fi

# Gitleaks bypass regressions. Each bypass hides a planted token from the OLD scan command (no .gitleaksignore removal,
# no --text, no --diff-merges) and must be caught by the workflow's current command. The old command is derived from the
# extracted script so the pair differs only in those hardening pieces; the "old passes" check proves each case really
# exercises its bypass.
# shellcheck disable=SC2016  # patterns are literal text to match in the workflow, not expansions
sed -e '/rm -f "\$PR\/.gitleaksignore"/d' \
    -e 's/--log-opts="--text --diff-merges=first-parent \${LOG_OPTS}"/--log-opts="${LOG_OPTS}"/' \
    "$RT/gl.sh" > "$RT/gl_old.sh"
if grep -q -e '--text' -e 'diff-merges' -e 'rm -f' "$RT/gl_old.sh"; then
  echo "old-command derivation: the hardening pieces were not stripped" >&2
  exit 2
fi
bash -n "$RT/gl_old.sh"

# (A) A PR-added .gitleaksignore carrying the leak's fingerprint (commit:file:rule:line) suppresses it.
make_repo bypass-ignore
printf 'token = "%s"\n' "$FAKE_CRED" > "$WORK/bypass-ignore/pr/leak.txt"
H0=$(commit_change bypass-ignore "planted token")
printf '%s:leak.txt:github-pat:1\n' "$H0" > "$WORK/bypass-ignore/pr/.gitleaksignore"
H=$(commit_change bypass-ignore "add .gitleaksignore")
check "bypass A .gitleaksignore -> old command passes (bypass works)" 0 bypass-ignore gl_old pull_request_target "$ZERO" "$H"
check_leak "bypass A .gitleaksignore -> gitleaks catches it" 1 bypass-ignore gl pull_request_target "$ZERO" "$H"

# (B) A PR-added .gitattributes line "leak.txt -diff" hides the file's content from the patch gitleaks parses.
make_repo bypass-attr
printf 'leak.txt -diff\n' > "$WORK/bypass-attr/pr/.gitattributes"
commit_change bypass-attr "add .gitattributes" > /dev/null
printf 'token = "%s"\n' "$FAKE_CRED" > "$WORK/bypass-attr/pr/leak.txt"
H=$(commit_change bypass-attr "planted token in second commit")
check "bypass B .gitattributes -diff -> old command passes (bypass works)" 0 bypass-attr gl_old pull_request_target "$ZERO" "$H"
check_leak "bypass B .gitattributes -diff -> gitleaks catches it" 1 bypass-attr gl pull_request_target "$ZERO" "$H"

# (C) A token that exists only in a merge commit's conflict resolution. Both branches change x.txt; the merge resolves it.
make_repo bypass-merge
(
  cd "$WORK/bypass-merge/pr"
  git checkout -q -b side master
  echo "side" > x.txt && git add x.txt && git commit -qm "side x"
  git checkout -q feat
  echo "feat" > x.txt && git add x.txt && git commit -qm "feat x"
  git merge --no-ff side > /dev/null 2>&1 || true
  [ -f .git/MERGE_HEAD ] || { echo "setup: expected a merge conflict" >&2; exit 2; }
  printf 'token = "%s"\n' "$FAKE_CRED" > x.txt
  git add x.txt && git commit -qm "merge with resolution"
  [ "$(git rev-list --parents -n 1 HEAD | wc -w)" = 3 ] || { echo "setup: head is not a two-parent merge" >&2; exit 2; }
)
H=$(cd "$WORK/bypass-merge/pr" && git rev-parse HEAD)
check "bypass C merge-only secret -> old command passes (bypass works)" 0 bypass-merge gl_old pull_request_target "$ZERO" "$H"
check_leak "bypass C merge-only secret -> gitleaks catches it" 1 bypass-merge gl pull_request_target "$ZERO" "$H"

# Control: a clean change with a harmless .gitattributes must pass the current command.
make_repo bypass-control
printf '* text=auto\n' > "$WORK/bypass-control/pr/.gitattributes"
printf 'harmless note\n' > "$WORK/bypass-control/pr/note.txt"
H=$(commit_change bypass-control "clean change")
check "bypass control (clean) -> gitleaks passes" 0 bypass-control gl pull_request_target "$ZERO" "$H"

# Pin contract. The install blocks are repeated in the gate jobs and in the selftest job: a composite action would be
# read from the PR checkout under pull_request_target, so the copies stay. Each pin below is FIXED here, not read from the
# workflow, and must appear on exactly two lines (its gate job and the selftest job). Format: NAME|VALUE, where NAME is
# empty for a pip requirement that has no variable name.
REQUIRED_PINS=(
  "ACTIONLINT_SHA256|023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757"
  "SHELLCHECK_SHA256|6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87"
  "GITLEAKS_SHA256|fa0500f6b7e41d28791ebc680f5dd9899cd42b58629218a5f041efa899151a8e"
  "|ruff==0.8.6 --hash=sha256:7ae4478b1471fc0c44ed52a6fb787e641a2ac58b1c1f91763bafbc2faddc5117"
)
pin_check() {
  local file="$1" spec name value n
  for spec in "${REQUIRED_PINS[@]}"; do
    name="${spec%%|*}"
    value="${spec#*|}"
    n=$(grep -cF -- "$value" "$file" || true)
    [ "$n" -eq 2 ] || return 1
    if [ -n "$name" ]; then
      n=$(grep -cE "^[[:space:]]*${name}: ${value}\$" "$file" || true)
      [ "$n" -eq 2 ] || return 1
    fi
  done
}
if pin_check "$WF"; then
  echo "PASS  pin contract: every required pin appears on exactly two lines"
else
  echo "FAIL  pin contract: a required pin is missing, changed, or on the wrong number of lines"
  FAILED=1
fi
# Mutation: remove one occurrence of each pin from a copy of the workflow. The contract must reject every copy.
for spec in "${REQUIRED_PINS[@]}"; do
  value="${spec#*|}"
  mutant="$RT/pin-mutant-$(printf '%s' "$value" | cksum | cut -d' ' -f1).yml"
  awk -v v="$value" '!done && index($0, v) { done = 1; next } { print }' "$WF" > "$mutant"
  if pin_check "$mutant"; then
    echo "FAIL  pin mutation: removing one occurrence of a pin was accepted (${value%%=*})"
    FAILED=1
  else
    echo "PASS  pin mutation: removing one occurrence of a pin is rejected (${value%%=*})"
  fi
done

# Verification contract. Every release download is checked with sha256sum -c before extraction: six checks in total
# (actionlint and shellcheck in the actionlint job, gitleaks in the gitleaks job, and all three in the selftest job).
# The pip installs use --require-hashes, in the ruff job and the selftest job. The pins above only prove a hash is
# declared; these counts prove each download is actually verified. Fixed here, not derived from the file.
verify_contract() {
  local file="$1" f seq
  # Per archive, in file order: download (C), checksum (S), extract (T). Each archive appears in two jobs, so the
  # sequence must be CST twice. Checking each archive on its own means one job's check cannot stand in for another's.
  for f in actionlint.tar.gz shellcheck.tar.xz gitleaks.tar.gz; do
    seq=$(awk -v f="$f" '
      index($0, "-o \"$RUNNER_TEMP/" f "\"") && index($0, "curl") { s = s "C" }
      index($0, "/" f "\" | sha256sum -c -") { s = s "S" }
      index($0, "tar -") && index($0, "\"$RUNNER_TEMP/" f "\"") { s = s "T" }
      END { print s }' "$file")
    [ "$seq" = "CSTCST" ] || return 1
  done
  [ "$(grep -c -- '--require-hashes' "$file" || true)" -eq 2 ]
}
if verify_contract "$WF"; then
  echo "PASS  verification contract: six sha256 checks and two hashed pip installs are present"
else
  echo "FAIL  verification contract: a download check or a hashed install is missing"
  FAILED=1
fi
# Mutation: a gate job that drops its sha256sum -c line still declares its hash, so only this check catches it.
mutant="$RT/verify-mutant.yml"
awk '!done && index($0, "sha256sum -c -") { done = 1; next } { print }' "$WF" > "$mutant"
if verify_contract "$mutant"; then
  echo "FAIL  verification mutation: removing a sha256sum -c line was accepted"
  FAILED=1
else
  echo "PASS  verification mutation: removing a sha256sum -c line is rejected"
fi
mutant="$RT/hashes-mutant.yml"
awk '!done && index($0, "--require-hashes") { done = 1; next } { print }' "$WF" > "$mutant"
if verify_contract "$mutant"; then
  echo "FAIL  verification mutation: removing a --require-hashes install was accepted"
  FAILED=1
else
  echo "PASS  verification mutation: removing a --require-hashes install is rejected"
fi

# Mutation: drop one archive's checksum line and duplicate another archive's checksum line. The aggregate count stays
# the same, so only the per-archive sequence can reject this.
mutant="$RT/swap-mutant.yml"
awk '
  index($0, "/actionlint.tar.gz\" | sha256sum -c -") && !removed { removed = 1; next }
  { print }
  index($0, "/shellcheck.tar.xz\" | sha256sum -c -") && !dup { dup = 1; print }
' "$WF" > "$mutant"
if verify_contract "$mutant"; then
  echo "FAIL  verification mutation: dropping one archive's check and duplicating another was accepted"
  FAILED=1
else
  echo "PASS  verification mutation: dropping one archive's check and duplicating another is rejected"
fi

if [ "$FAILED" = 0 ]; then
  echo "ALL CASES PASSED"
else
  echo "SOME CASES FAILED" >&2
  exit 1
fi
