#!/usr/bin/env bash
# T37-W1c: prints (default) or installs (--install) a pre-commit hook that runs
# scripts/commit_guard.py on staged changes across main checkouts and linked worktrees.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
TOP="$(git -C "$LOCAL_REPO" rev-parse --show-toplevel 2>/dev/null || echo "$LOCAL_REPO")"
COMMON_DIR="$(git -C "$TOP" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
FALLBACK_REPO="$LOCAL_REPO"
[ -n "$COMMON_DIR" ] && FALLBACK_REPO="$(cd "$(dirname "$COMMON_DIR")" && pwd)"

CORE_HP="$(git -C "$TOP" config --get core.hooksPath 2>/dev/null || true)"
if [ -n "$CORE_HP" ]; then
  [[ "$CORE_HP" = /* ]] || CORE_HP="$TOP/$CORE_HP"
  if [ ! -d "$CORE_HP" ]; then
    echo "WARNING: core.hooksPath points to missing directory '$CORE_HP' (git ignores .git/hooks while this is set)." >&2
  fi
fi

HOOK="$(git -C "$TOP" rev-parse --git-path hooks/pre-commit 2>/dev/null || echo "$TOP/.git/hooks/pre-commit")"
[[ "$HOOK" = /* ]] || HOOK="$TOP/$HOOK"

BODY="#!/usr/bin/env bash
# T37-W1c commit guard (I8+I9). Blocks staged secrets / business-sensitive text / forbidden paths.
TOP=\"\$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' '$FALLBACK_REPO')\"
GUARD=\"\$TOP/scripts/commit_guard.py\"
[ -f \"\$GUARD\" ] || GUARD='$FALLBACK_REPO/scripts/commit_guard.py'
python3 \"\$GUARD\" \"\$@\" || exit 1
"
if [ "${1:-}" = "--install" ]; then
  mkdir -p "$(dirname "$HOOK")"
  printf '%s\n' "$BODY" > "$HOOK"
  chmod +x "$HOOK"
  echo "installed: $HOOK"
else
  printf '%s\n' "$BODY"
  echo "# (dry run — pass --install to write $HOOK)" >&2
fi
