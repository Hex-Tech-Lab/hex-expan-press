#!/usr/bin/env python3
"""Jev gate: alt-text adequacy (T36-J8). For every #chaphead(img:, alt:) and #image(alt:) in the
manuscript, asks Jev noul `adequate_alt`: is this a concise, concrete description of the image,
useful to a screen-reader user, without "image of" boilerplate?
Bands: FLAG at p < 0.8 (listed in report); missing alt = FAIL; Jev down / --no-jev -> UNCHECKED.
Writes <QA>/alt_text_report.md (rendered to .html). Exit 1 on any FAIL.

Usage: python3 scripts/alt_text_check.py [--no-jev]
"""
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import MS, QA  # noqa: E402
from jev import decide  # noqa: E402

HI = 0.8
Q = {"adequate_alt": {"type": "noul",
                      "instructions": "Given the alt text and the chapter title: is this a concise, concrete "
                                      "description of the image, useful to a screen-reader user, without 'image of' boilerplate?",
                      "criteria": {"true": "Concrete, concise, screen-reader useful, no boilerplate.",
                                   "false": "Vague, generic, boilerplate ('image of'), or missing key content."}}}


def line_of(pos, text):
    return text.count("\n", 0, pos) + 1


rows, worst = [], 0
MS_TEXT = MS.read_text()
for m in re.finditer(r'#chaphead\("Chapter (\w+)", "[^"]*", "([^"]+)".*?(?:img: "([^"]*)", )?alt: "([^"]*)"', MS_TEXT):
    chap, title, img, alt = m.group(1), m.group(2), m.group(3), m.group(4)
    rows.append((f"chaphead Chapter {chap}", title, line_of(m.start(), MS_TEXT), img, alt))
for m in re.finditer(r'#image\("([^"]*)"(?:\s*,[^)]*?alt: "([^"]*)")?', MS_TEXT):
    img, alt = m.group(1), m.group(2)
    pos = MS_TEXT.rfind("#chaphead(", 0, m.start())
    chap = re.search(r'"Chapter (\w+)", "[^"]*", "([^"]+)"', MS_TEXT[pos:pos + 200]) if pos >= 0 else None
    rows.append((f"image {img}", chap.group(2) if chap else "", line_of(m.start(), MS_TEXT), img, alt or ""))

out = ["# ALT TEXT — adequacy gate (T36-J8)", "",
       "| Location | Chapter | Image | Result | Alt text |", "|---|---|---|---|---|"]
for loc, chap, ln, img, alt in rows:
    if not alt:
        res, worst = "FAIL: missing alt", 1
    elif "--no-jev" in sys.argv:
        res = "UNCHECKED (Jev off)"
    else:
        a = decide({"alt_text": alt, "chapter_title": chap}, Q, timeout=20)
        if a is None:
            res = "UNCHECKED (Jev unavailable)"
        else:
            p = a["adequate_alt"]["noul"]
            res = f"{'PASS' if p >= HI else 'FLAG'} (p={p:.2f})"
            if p < HI:
                worst = worst or 0  # FLAG does not fail the gate
    out.append(f"| {loc} (line {ln}) | {chap} | {img or '—'} | {res} | {alt.replace('|', '/')} |")

rep = QA / "alt_text_report.md"
rep.write_text("\n".join(out) + "\n")
subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
n_fail = sum("FAIL" in r for r in out if r.startswith("|") and "---" not in r)
print(f"ALT TEXT: {'FAIL' if worst else 'PASS'} ({n_fail} FAIL) -> {rep}")
sys.exit(1 if worst else 0)
