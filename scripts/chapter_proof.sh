#!/usr/bin/env bash
# Build a proof PDF of the book up to the end of chapter N (N = One..Ten word as in chaphead),
# same Pandoc->Typst pipeline, then run the tracking->Tc pass. Main release untouched.
# Usage: scripts/chapter_proof.sh Two   -> $RELEASES/proofs/proof_to_ch_Two.pdf
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; eval "$(python3 "$REPO/scripts/book_config.py" --shell)"; B="$BOOK_DIR"
NEXT="${2:-}"; N="$1"
OUT="$RELEASES/proofs/proof_to_ch_${N}.pdf"; mkdir -p "$(dirname "$OUT")"
M="$MS"; W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; ln -s "$B/img_v3" "$W/img_v3"; ln -s "$QA/design_rules.json" "$W/design_rules.json"
if [ -n "$NEXT" ]; then
  L=$(grep -n "#chaphead(\"Chapter $NEXT\"" "$M" | cut -d: -f1); while [ "$(sed -n "${L}p" "$M")" != '```{=typst}' ]; do L=$((L-1)); done
  head -n $((L-1)) "$M" > "$W/m.md"
else cp "$M" "$W/m.md"; fi
cp "$TEMPLATE" "$W/"
# cover_data.json: same input the release build generates (book_build.sh) — template.typ reads it directly.
python3 -c 'import json,sys; cfg=json.load(open(sys.argv[1])); print(json.dumps(cfg.get("cover",{}),indent=1))' "$REPO/books/$BOOK_ID.json" > "$W/cover_data.json"
cd "$W" && "$REPO/.tools/pandoc/bin/pandoc" m.md $PANDOC_FLAGS --template="$(basename "$TEMPLATE")" -o b.typ
"$REPO/.tools/typst-0.15.1/typst" compile $TYPST_FLAGS --font-path "$FONT_DIR_1" --font-path "$FONT_DIR_2" b.typ "$OUT"
"$REPO/.tools/pdfenv/bin/python" "$REPO/scripts/pdf_tracking_to_tc.py" "$OUT"
echo "proof: $OUT"
# Gate: never more than one breakout box on a page.
PAGES=$(pdfinfo "$OUT" 2>/dev/null | awk '/^Pages/{print $2}'); FAIL=0
for p in $(seq 1 "$PAGES"); do
  n=$(pdftotext -f "$p" -l "$p" "$OUT" - 2>/dev/null | tr -d ' ' | grep -cE '^(LENS|YOURWORKSHEET|CORROBORATED|SIDEBAR)·' || true)
  if [ "$n" -gt 1 ]; then echo "GATE FAIL: page $p has $n boxes"; FAIL=1; fi
done
[ "$FAIL" = 0 ] && echo "gate: one box per page OK" || exit 2
# Full rule-set QA (ADR 0043). QA_CHAPTERS=One,Four overrides; default = the chapters
# actually included in this proof (derived from its chapheads, so FULL = all).
QA_CH="${QA_CHAPTERS:-$(grep -o 'chaphead("Chapter [A-Za-z]*' "$W/m.md" | sed 's/.*Chapter //' | paste -sd, -)}"
"$REPO/.tools/pdfenv/bin/python" "$REPO/scripts/book_qa.py" --pdf "$OUT" --chapters "$QA_CH" \
  --out "$QA/qa_report_${N}.md" | tail -1
# Visual regression for chapters with an approved baseline (skips the rest).
"$REPO/.tools/pdfenv/bin/python" "$REPO/scripts/visual_regress.py" --pdf "$OUT" --chapters "$QA_CH"
