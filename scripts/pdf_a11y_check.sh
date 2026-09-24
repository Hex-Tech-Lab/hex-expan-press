#!/usr/bin/env bash
# pdf_a11y_check.sh <pdf> — T35-K4 automated accessibility gate for a release PDF.
#   1. veraPDF (official docker image verapdf/cli) with the PDF/UA-1 profile (flavour ua1),
#      PDF's directory mounted READ-ONLY; machine report -> <pdf dir>/<name>.verapdf.xml.
#      Summary: passed rules, failed rules grouped by rule id with counts. Exit 1 on failures.
#   2. Contrast check (pdfplumber via .tools/pdfenv/bin/python): flag any text < 14pt whose
#      contrast vs the page background #F7F1E3 (or box bg #ECE4D2 when inside a box rect)
#      is < 4.5:1, and any text < 7.5pt (any contrast).
# Requires: docker, .tools/pdfenv (pdfplumber).
set -u
PDF="${1:?usage: pdf_a11y_check.sh <pdf>}"
PDF_ABS="$(readlink -f "$PDF")"
[ -f "$PDF_ABS" ] || { echo "pdf_a11y_check: no such file: $PDF" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PDFENV="$REPO/.tools/pdfenv/bin/python"
PY="$PDFENV"
[ -x "$PY" ] || PY=python3
DIR="$(dirname "$PDF_ABS")"
NAME="$(basename "$PDF_ABS")"
STEM="${NAME%.pdf}"
XML="$DIR/$STEM.verapdf.xml"

echo "== veraPDF PDF/UA-1 (verapdf/cli) =="
docker run --rm -v "$DIR":/pdf:ro verapdf/cli --flavour ua1 "/pdf/$NAME" > "$XML" || {
  echo "pdf_a11y_check: veraPDF run failed (see $XML)" >&2; exit 2;
}
"$PY" - "$XML" <<'PYEOF'
import sys, xml.etree.ElementTree as ET
tree = ET.parse(sys.argv[1])
failed = {}
passed_rules = None
for d in tree.iter("details"):
    pr = d.get("passedRules")
    if pr is not None and passed_rules is None:
        passed_rules = int(pr)
    for c in d.iter("check"):
        if c.get("status") == "FAILED":
            r = c.get("id", "?")
            failed[r] = failed.get(r, 0) + 1
for vr in tree.iter("validationReport"):
    if vr.get("isCompliant") is not None:
        print(f"compliant: {vr.get('isCompliant')}  profile: {vr.get('profileName')}")
        break
print(f"passed rules: {passed_rules if passed_rules is not None else '?'}")
print(f"failed rules: {len(failed)}")
for r in sorted(failed):
    print(f"  FAIL {r}: {failed[r]} check(s)")
sys.exit(1 if failed else 0)
PYEOF
VRC=$?

echo
echo "== contrast / minimum size check (pdfplumber) =="
"$PY" - "$PDF_ABS" <<'PYEOF'
import sys, collections

def rgb(v):
    if not isinstance(v, (tuple, list)) or not v:
        return None
    if len(v) == 1:  # grayscale
        return (v[0],) * 3
    if len(v) == 3:
        return tuple(v)
    if len(v) == 4:  # CMYK -> naive RGB
        c, m, y, k = v
        return tuple((1 - min(1, x + k)) for x in (c, m, y))
    return None

def lum(c):
    def f(x):
        x = min(1.0, max(0.0, x))
        return x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])

def contrast(a, b):
    l1, l2 = sorted((lum(a), lum(b)), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)

PAGE_BG = (0xF7 / 255, 0xF1 / 255, 0xE3 / 255)  # #F7F1E3
BOX_BG = (0xEC / 255, 0xE4 / 255, 0xD2 / 255)   # #ECE4D2
TOL = 0.01

import pdfplumber
p = pdfplumber.open(sys.argv[1])
flags = collections.Counter()
total_small = 0
for pg in p.pages:
    # every filled rect/curve is a potential background (page bg #F7F1E3 is itself a big
    # rect; dark banners/knock-out text are others). Innermost containing one wins.
    fills = [r for r in pg.rects + pg.curves if r.get("fill") and rgb(r.get("non_stroking_color"))]
    for ch in pg.chars:
        size = ch.get("size", 0.0)
        c = rgb(ch.get("non_stroking_color"))
        if c is None or size <= 0:
            continue
        cands = [b for b in fills
                 if b["x0"] - TOL <= ch["x0"] and ch["x1"] <= b["x1"] + TOL
                 and b["top"] - TOL <= ch["top"] and ch["bottom"] <= b["bottom"] + TOL]
        if cands:
            b = min(cands, key=lambda r: (r["x1"] - r["x0"]) * (r["bottom"] - r["top"]))
            bg = rgb(b["non_stroking_color"])
        else:
            bg = PAGE_BG
        ratio = contrast(c, bg)
        hexc = "%02X%02X%02X" % tuple(round(x * 255) for x in c)
        hexb = "%02X%02X%02X" % tuple(round(x * 255) for x in bg)
        if size < 14.0 and ratio < 4.5:
            flags[("LOW-CONTRAST", f"size={size:.1f}pt color=#{hexc} bg=#{hexb} ratio={ratio:.2f}")] += 1
        if size < 7.5:
            total_small += 1
            flags[("SMALL-TEXT", f"size={size:.1f}pt color=#{hexc} bg=#{hexb} ratio={ratio:.2f}")] += 1

print(f"text chars < 7.5pt: {total_small}")
if not flags:
    print("contrast: no flags")
else:
    print(f"contrast/size: {sum(flags.values())} flagged char(s), grouped:")
    for (kind, det), n in sorted(flags.items()):
        print(f"  {kind} x{n}: {det}")
sys.exit(1 if flags else 0)
PYEOF
CRC=$?

echo
if [ "$VRC" -ne 0 ] || [ "$CRC" -ne 0 ]; then
  echo "pdf_a11y_check: FAIL (veraPDF exit=$VRC, contrast exit=$CRC)"
  exit 1
fi
echo "pdf_a11y_check: PASS"
exit 0
