#!/usr/bin/env python3
"""Rewrite Typst letter-tracking into real PDF character spacing (Tc).

Typst writes `tracking:` as a per-glyph offset inside each TJ array. Acrobat's
editor reads those offsets as space characters. This pass finds TJ arrays where
one offset repeats between most glyphs, moves that amount into `Tc`, and keeps
any kerning residue in the array. Glyph positions are unchanged.
Usage: pdf_tracking_to_tc.py in.pdf [out.pdf]   (in place if out omitted)

Lesson P-11: after rewriting, every page's text (pdfplumber extract_words
text + rounded x0/top to 0.5pt) is verified identical before/after for
NON-tracked runs; prints "tracking verify: OK" or lists mismatching pages
and exits 1.
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

def page_words(path, page_index):
    """Text words as (text, x0, top) with x0/top rounded to 0.5pt (P-11)."""
    import pdfplumber
    with pdfplumber.open(path) as doc:
        return sorted(
            (w["text"], round(w["x0"] * 2) / 2, round(w["top"] * 2) / 2)
            for w in doc.pages[page_index].extract_words()
        )

def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    pdf = pikepdf.open(src, allow_overwriting_input=True)
    changed, total, n = {}, 0, 0
    for p in pdf.pages:
        c = fix_page(pdf, p)
        changed[n] = c
        total += c
        n += 1
    # P-11 snapshot BEFORE the save: src on disk is still the original.
    before = {i: page_words(src, i) for i, c in changed.items() if c == 0}
    pdf.save(dst)
    print(f"tracking->Tc: {total} text runs rewritten")

    bad = [i for i, snap in before.items() if page_words(dst, i) != snap]
    if bad:
        print("tracking verify: MISMATCH on pages", bad)
        sys.exit(1)
    print("tracking verify: OK")

if __name__ == "__main__":
    main()
