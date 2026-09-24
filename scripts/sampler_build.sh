#!/usr/bin/env bash
# Sampler build (subset PDFs) — follows the frozen Pandoc-first pipeline of
# scripts/book_build.sh (ADR 0037/0038): a TEMP truncated manuscript copy is
# compiled via pandoc -> typst; the canonical manuscript.md and template.typ
# are never touched. build.typ is generated into the sampler workdir, never
# hand-edited.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
eval "$(python3 "$REPO_ROOT/scripts/book_config.py" --shell)"
PANDOC="$REPO_ROOT/.tools/pandoc/bin/pandoc"
TYPST="$REPO_ROOT/.tools/typst-0.15.1/typst"
RELEASES_DIR="$RELEASES/samplers"
WORK_DIR="$RELEASES_DIR/.work"

TARGET="${1:-}"
case "$TARGET" in
  --target=creator-review) TARGET_KIND="creator-review" ;;
  --target=customer-sample) TARGET_KIND="customer-sample" ;;
  *) echo "usage: $0 --target=creator-review|--target=customer-sample" >&2; exit 1 ;;
esac

for bin in "$PANDOC" "$TYPST"; do
  [ -x "$bin" ] || { echo "missing/non-executable: $bin (run pnpm freeze:check)" >&2; exit 1; }
done
[ -e "$BOOK_DIR/img_v3" ] || { echo "missing $BOOK_DIR/img_v3 (should be a symlink to typst_prototype/img_v3)" >&2; exit 1; }
[ -f "$MS" ] || { echo "missing $MS" >&2; exit 1; }

mkdir -p "$WORK_DIR" "$RELEASES_DIR"
# typst resolves image paths relative to the .typ file, so mirror the
# BOOK_DIR img_v3 symlink (it already points at typst_prototype/img_v3).
[ -e "$WORK_DIR/img_v3" ] || ln -s "$BOOK_DIR/img_v3" "$WORK_DIR/img_v3"
[ -e "$WORK_DIR/design_rules.json" ] || ln -s "$QA/design_rules.json" "$WORK_DIR/design_rules.json"
TMP_MANUSCRIPT="$WORK_DIR/manuscript_${TARGET_KIND}_$$.md"
TMP_BUILD="$WORK_DIR/build_${TARGET_KIND}_$$.typ"

cleanup() {
  rm -f "$TMP_MANUSCRIPT" "$TMP_BUILD"
  rmdir "$WORK_DIR/img_v3" 2>/dev/null || true
}
trap cleanup EXIT

# Copy (never touch the canonical manuscript), then truncate at end of
# Chapter 2. Locate the third chapter chaphead dynamically instead of
# hardcoding a line number.
CH3_NAME="$(echo "$CHAPTERS" | cut -d, -f3)"
CH3_MARKER="#chaphead(\"Chapter $CH3_NAME\""
CH3_LINE="$(grep -n "$CH3_MARKER" "$MS" | head -1 | cut -d: -f1)"
[ -n "$CH3_LINE" ] || { echo "could not locate Chapter $CH3_NAME chaphead in $MS" >&2; exit 1; }

case "$TARGET_KIND" in
  customer-sample)
    CTA_BLOCK='```{=typst}
#pagebreak(to: "odd")
#align(center)[
  #block(fill: rgb("#f2f2ee"), inset: 18pt, radius: 6pt, width: 80%)[
    #set text(size: 1.1em, weight: "bold")
    Buy the Full Playbook
    #v(0.5em)
    #set text(size: 0.85em, weight: "regular")
    You have read the first two chapters of _The Boring Path to \$8,000 a Month_.
    The full playbook continues with all ten chapters, the worksheets, and the
    final plan. Get it at the store where you downloaded this sample.
  ]
]
```'
    ;;
  creator-review)
    CTA_BLOCK='```{=typst}
#align(center)[
  #block(fill: rgb("#f2f2ee"), inset: 18pt, radius: 6pt, width: 80%)[
    #set text(size: 1.1em, weight: "bold")
    REVIEW COPY — NOT FOR DISTRIBUTION
    #v(0.5em)
    #set text(size: 0.85em, weight: "regular")
    This sampler contains chapters 1–2 of _The Boring Path to \$8,000 a Month_
    and is provided for review purposes only. It is an unfinished draft: not
    for resale, redistribution, or quoting. Contents subject to change.
  ]
]
```'
    ;;
esac

# Keep lines 1..(fence_start - 1). The third-chapter chaphead sits inside a
# ```{=typst} fence block; cutting at CH3_LINE - 1 would split the fence open
# and corrupt pandoc's fence parsing for everything after it, so walk back to
# the fence opener line.
CUT_LINE="$CH3_LINE"
while [ "$(sed -n "${CUT_LINE}p" "$MS")" != '```{=typst}' ]; do
  CUT_LINE=$((CUT_LINE - 1))
  [ "$CUT_LINE" -gt 0 ] || { echo "unterminated typst fence before Chapter $CH3_NAME marker" >&2; exit 1; }
done
head -n $((CUT_LINE - 1)) "$MS" > "$TMP_MANUSCRIPT"

# Truncation sanity check: temp copy must contain ch1+ch2 chapheads but NOT ch3.
for m in "Chapter $(echo "$CHAPTERS" | cut -d, -f1)" "Chapter $(echo "$CHAPTERS" | cut -d, -f2)"; do
  grep -q "$m" "$TMP_MANUSCRIPT" || { echo "truncation sanity check failed: $m missing from temp copy" >&2; exit 1; }
done
if grep -q "$CH3_MARKER" "$TMP_MANUSCRIPT"; then
  echo "truncation sanity check failed: Chapter $CH3_NAME marker still present in temp copy" >&2
  exit 1
fi

# Append the CTA/review-closure block (same {=typst} fence style as the rest of
# the manuscript so pandoc passes it through verbatim).
{
  printf '%s\n\n' "$CTA_BLOCK"
} >> "$TMP_MANUSCRIPT"

OUT_PDF="$RELEASES_DIR/${TARGET_KIND}_$(date +%Y-%m-%d_%H%M).pdf"

(
  cd "$BOOK_DIR"
  "$PANDOC" "$TMP_MANUSCRIPT" $PANDOC_FLAGS --template="$TEMPLATE" -o "$TMP_BUILD"
  "$TYPST" compile $TYPST_FLAGS --font-path "$FONT_DIR_1" --font-path "$FONT_DIR_2" "$TMP_BUILD" "$OUT_PDF"
)

echo "built: $OUT_PDF"
