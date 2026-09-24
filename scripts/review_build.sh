#!/usr/bin/env bash
# Build the creator review copy: manuscript copy with yellow highlight marks
# applied (marks JSON only touches the temp copy), full Pandoc->Typst pipeline
# + tracking->Tc pass. Never edits manuscript.md. No QA gates (review copy).
# Usage: scripts/review_build.sh [marks_json]
#   default marks: $QA/review_marks.json
# Output: $RELEASES/review/<BOOK_ID>_review_copy_<YYYY-MM-DD_HHMM>.pdf
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; eval "$(python3 "$REPO/scripts/book_config.py" --shell)"; B="$BOOK_DIR"
MARKS="${1:-$QA/review_marks.json}"
STAMP="$(date +%Y-%m-%d_%H%M)"
OUTDIR="$RELEASES/review"; mkdir -p "$OUTDIR"
OUT="$OUTDIR/${BOOK_ID}_review_copy_${STAMP}.pdf"
QA_DIR="$QA"
W="$(mktemp -d "$QA_DIR/work_review.XXXXXX")"; trap 'rm -rf "$W"' EXIT
ln -s "$B/img_v3" "$W/img_v3"; ln -s "$QA_DIR/design_rules.json" "$W/design_rules.json"
"$REPO/.tools/pdfenv/bin/python" "$REPO/scripts/review_marks.py" "$MS" "$MARKS" "$W/m.md"
cp "$TEMPLATE" "$W/"
cd "$W" && "$REPO/.tools/pandoc/bin/pandoc" m.md $PANDOC_FLAGS --template="$(basename "$TEMPLATE")" -o b.typ
"$REPO/.tools/typst-0.15.1/typst" compile $TYPST_FLAGS --font-path "$FONT_DIR_1" --font-path "$FONT_DIR_2" b.typ "$OUT"
"$REPO/.tools/pdfenv/bin/python" "$REPO/scripts/pdf_tracking_to_tc.py" "$OUT"
echo "review copy: $OUT"
