#!/usr/bin/env bash
# Two re-grade runs for a chapter against a saved "before" manuscript, then the summary.
set -u; REPO="$(cd "$(dirname "$0")/.." && pwd)"; C="$1"; BEFORE="$2"
eval "$(python3 "$REPO/scripts/book_config.py" --shell)"; B="$QA/chapter_briefs"
N=$(python3 -c "import sys; sys.path.insert(0, '$REPO/scripts'); from book_config import CHAPTERS; print(CHAPTERS.index('$C')+1)")
for i in 1 2; do timeout 2400 python3 "$REPO/scripts/chapter_regrade.py" "$C" "$BEFORE" >/dev/null 2>&1; cp "$B/ch${N}_regrade.json" "$B/ch${N}_regrade_run$i.json"; done
python3 "$REPO/scripts/regrade_summary.py" "$C" "$B/ch${N}_regrade_run1.json" "$B/ch${N}_regrade_run2.json" | tee "$B/ch${N}_regrade_summary.md"
