#!/usr/bin/env bash
# Lesson P-19: every report must be rendered. Pandoc md -> html, title from
# the first heading, output next to the input.
#   scripts/render_report.sh <in.md>
set -euo pipefail

IN="${1:-}"
[ -z "$IN" ] && { echo "usage: render_report.sh <in.md>" >&2; exit 2; }
[ -f "$IN" ] || { echo "render_report: no such file: $IN" >&2; exit 2; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "${IN#/}" = "$IN" ] && IN="$REPO/$IN"
OUT="${IN%.md}.html"

TITLE="$("$REPO/.tools/pandoc/bin/pandoc" "$IN" -t plain 2>/dev/null | grep -m1 '^#' | sed 's/^#\+\s*//' || true)"
[ -z "$TITLE" ] && TITLE="$(basename "${IN%.md}")"

"$REPO/.tools/pandoc/bin/pandoc" "$IN" \
  -f markdown-yaml_metadata_block \
  --metadata "title=$TITLE" \
  --standalone \
  --output="$OUT"
echo "rendered: $OUT"
