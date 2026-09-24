#!/usr/bin/env bash
# T37-W1c: prints (default) or installs (--install) a pre-commit hook that runs
# scripts/commit_guard.py on staged changes. The orchestrator decides whether to run --install.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO/.git/hooks/pre-commit"
BODY="#!/usr/bin/env bash
# T37-W1c commit guard (I8+I9). Blocks staged secrets / business-sensitive text / forbidden paths.
python3 '$REPO/scripts/commit_guard.py' \"\$@\" || exit 1
"
if [ "${1:-}" = "--install" ]; then
  printf '%s\n' "$BODY" > "$HOOK"
  chmod +x "$HOOK"
  echo "installed: $HOOK"
else
  printf '%s\n' "$BODY"
  echo "# (dry run — pass --install to write $HOOK)" >&2
fi
