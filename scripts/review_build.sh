#!/usr/bin/env bash
# Build the creator review copy: manuscript copy with yellow highlight marks
# applied (marks JSON only touches the temp copy), full Pandoc->Typst pipeline
# + tracking->Tc pass. Never edits manuscript.md. No QA gates (review copy).
# Usage: scripts/review_build.sh [marks_json]
#   default marks: data/intel/duane_book/qa/review_marks.json
# Output: data/intel/duane_book/releases/review/duane_review_copy_<YYYY-MM-DD_HHMM>.pdf
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; B="$REPO/manuscript/book"
MARKS="${1:-$REPO/data/intel/duane_book/qa/review_marks.json}"
STAMP="$(date +%Y-%m-%d_%H%M)"
OUTDIR="$REPO/data/intel/duane_book/releases/review"; mkdir -p "$OUTDIR"
OUT="$OUTDIR/duane_review_copy_${STAMP}.pdf"
QA="$REPO/data/intel/duane_book/qa"
W="$(mktemp -d "$QA/work_review.XXXXXX")"; trap 'rm -rf "$W"' EXIT
ln -s "$B/img_v3" "$W/img_v3"; ln -s "$QA/design_rules.json" "$W/design_rules.json"
"$REPO/.tools/pdfenv/bin/python" "$REPO/scripts/review_marks.py" "$B/manuscript.md" "$MARKS" "$W/m.md"
cp "$B/template.typ" "$W/"
cd "$W" && "$REPO/.tools/pandoc/bin/pandoc" m.md --to typst --wrap=none --shift-heading-level-by=-1 --template=template.typ -o b.typ
"$REPO/.tools/typst-0.15.1/typst" compile --font-path "$REPO/typst_prototype/fonts" --font-path "$REPO/typst_prototype/fonts_variable" b.typ "$OUT"
"$REPO/.tools/pdfenv/bin/python" "$REPO/scripts/pdf_tracking_to_tc.py" "$OUT"
echo "review copy: $OUT"
