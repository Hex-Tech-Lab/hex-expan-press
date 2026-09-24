#!/usr/bin/env bash
# Reproducible Pandoc-first book compile (ADR 0037). See AGENTS.md / CLAUDE.md
# for the frozen-pipeline rule: manuscript.md + template.typ are the only
# hand-edited inputs; the intermediate build.typ and output PDF are generated.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOK_DIR="$REPO_ROOT/manuscript/book"
PANDOC="$REPO_ROOT/.tools/pandoc/bin/pandoc"
TYPST="$REPO_ROOT/.tools/typst-0.15.1/typst"
FONT_DIR_1="$REPO_ROOT/typst_prototype/fonts"
FONT_DIR_2="$REPO_ROOT/typst_prototype/fonts_variable"
OUT_PDF="${1:-$REPO_ROOT/data/intel/duane_book/book_pandoc_$(date +%Y-%m-%d_%H%M).pdf}"

for bin in "$PANDOC" "$TYPST"; do
  [ -x "$bin" ] || { echo "missing/non-executable: $bin (run pnpm freeze:check)" >&2; exit 1; }
done
[ -e "$BOOK_DIR/img_v3" ] || { echo "missing $BOOK_DIR/img_v3 (should be a symlink to typst_prototype/img_v3)" >&2; exit 1; }

mkdir -p "$(dirname "$OUT_PDF")"

cd "$BOOK_DIR"
"$PANDOC" manuscript.md --to typst --wrap=none --shift-heading-level-by=-1 --template=template.typ -o build.typ
"$TYPST" compile --pdf-standard ua-1 --font-path "$FONT_DIR_1" --font-path "$FONT_DIR_2" build.typ "$OUT_PDF"

"$REPO_ROOT/.tools/pdfenv/bin/python" "$REPO_ROOT/scripts/pdf_viewer_prefs.py" "$OUT_PDF"
echo "built: $OUT_PDF"
