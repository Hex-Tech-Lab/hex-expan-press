#!/usr/bin/env bash
# Two re-grade runs for a chapter against a saved "before" manuscript, then the summary.
set -u; REPO="$(cd "$(dirname "$0")/.." && pwd)"; C="$1"; BEFORE="$2"; B="$REPO/data/intel/duane_book/qa/chapter_briefs"
N=$(python3 -c "print('One Two Three Four Five Six Seven Eight Nine Ten'.split().index('$C')+1)")
for i in 1 2; do timeout 2400 python3 "$REPO/scripts/chapter_regrade.py" "$C" "$BEFORE" >/dev/null 2>&1; cp "$B/ch${N}_regrade.json" "$B/ch${N}_regrade_run$i.json"; done
python3 "$REPO/scripts/regrade_summary.py" "$C" "$B/ch${N}_regrade_run1.json" "$B/ch${N}_regrade_run2.json" | tee "$B/ch${N}_regrade_summary.md"
