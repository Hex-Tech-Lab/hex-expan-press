#!/usr/bin/env python3
"""Rewrite Typst letter-tracking into real PDF character spacing (Tc).

Typst writes `tracking:` as a per-glyph offset inside each TJ array. Acrobat's
editor reads those offsets as space characters. This pass finds TJ arrays where
one offset repeats between most glyphs, moves that amount into `Tc`, and keeps
any kerning residue in the array. Glyph positions are unchanged.
Usage: pdf_tracking_to_tc.py in.pdf [out.pdf]   (in place if out omitted)
"""
import sys
from collections import Counter
from decimal import Decimal
import pikepdf

NUM = (int, float, Decimal)

def fix_page(pdf, page):
    ops = pikepdf.parse_content_stream(page)
    out, size, changed = [], None, 0
    for operands, op in ops:
        name = str(op)
        if name == "Tf":
            size = float(operands[1])
        if name == "TJ" and size:
            arr = list(operands[0])
            gaps = [float(x) for x in arr if isinstance(x, NUM)]
            strs = [x for x in arr if not isinstance(x, NUM)]
            # tracked text is written one glyph per string (2 bytes, CID font); body text is not
            single = all(len(bytes(x)) == 2 for x in strs)
            if single and len(gaps) >= 4 and len(strs) >= 5:
                common, n = Counter(round(g, 1) for g in gaps).most_common(1)[0]
                if common < -50 and n / len(gaps) >= 0.6:
                    track = -common  # thousandths of an em
                    new = []
                    for x in arr:
                        if not isinstance(x, NUM):
                            new.append(x)
                        else:
                            r = float(x) + track
                            if abs(r) > 0.01:
                                new.append(r)
                    # Tc also applies after the final glyph; compensate so following text doesn't move.
                    new.append(track)
                    tc = track / 1000 * size
                    out.append(([tc], pikepdf.Operator("Tc")))
                    out.append(([pikepdf.Array(new)], op))
                    out.append(([0], pikepdf.Operator("Tc")))
                    changed += 1
                    continue
        out.append((operands, op))
    if changed:
        page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(out))
    return changed

def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    pdf = pikepdf.open(src, allow_overwriting_input=True)
    total = sum(fix_page(pdf, p) for p in pdf.pages)
    pdf.save(dst)
    print(f"tracking->Tc: {total} text runs rewritten")

if __name__ == "__main__":
    main()
