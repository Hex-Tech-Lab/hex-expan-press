"""Single source of truth for WHICH book the engine is working on.

Every script imports its paths and chapter list from here instead of hard-coding them, so a new book
is a new `books/<id>.json` plus `BOOK=<id>` in the environment (default: duane).

    from book_config import CFG, REPO, BOOK_DIR, MS, TEMPLATE, DATA, QA, RELEASES, CHAPTERS
    python3 scripts/book_config.py --shell   # KEY=value lines for bash: eval "$(python3 scripts/book_config.py --shell)"

CHAPTERS is read from the manuscript itself (every `#chaphead("Chapter <Name>"`), so the chapter
count and names are never hard-coded.
"""
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BOOK_ID = os.environ.get("BOOK", "duane")
CFG = json.loads((REPO / "books" / f"{BOOK_ID}.json").read_text())

BOOK_DIR = REPO / CFG["book_dir"]
MS = BOOK_DIR / CFG.get("manuscript", "manuscript.md")
TEMPLATE = BOOK_DIR / CFG.get("template", "template.typ")
DATA = REPO / CFG["data_dir"]
QA = DATA / "qa"
RELEASES = DATA / "releases"
FONTS = [REPO / f for f in CFG.get("fonts", [])]
PANDOC = REPO / ".tools/pandoc/bin/pandoc"
TYPST = REPO / ".tools/typst-0.15.1/typst"
PDF_PY = REPO / ".tools/pdfenv/bin/python"
# Build flags shared by EVERY tool that compiles the book (lesson X-: a tool with different flags "proved" false fits).
PANDOC_FLAGS = ["--to", "typst", "--wrap=none", "--shift-heading-level-by=-1",
                "--lua-filter", str(REPO / "scripts/rawblock_parbreak.lua")]  # parbreak after raw blocks (merged-paragraph bug)
TYPST_FLAGS = ["--pdf-standard", "ua-1"]


def chapters(ms_text=None):
    """Chapter names in book order, from the manuscript's #chaphead("Chapter <Name>" calls."""
    t = ms_text if ms_text is not None else (MS.read_text() if MS.exists() else "")
    return re.findall(r'#chaphead\("Chapter ([A-Za-z]+)"', t)


def parts(ms_text=None):
    """{part numeral: [chapter names]} from #partpage("<numeral>", ...) markers; one part "ALL" if the book has none."""
    t = ms_text if ms_text is not None else (MS.read_text() if MS.exists() else "")
    out, cur = {}, None
    for m in re.finditer(r'#partpage\("([^"]+)"|#chaphead\("Chapter ([A-Za-z]+)"', t):
        if m.group(1):
            cur = m.group(1); out[cur] = []
        else:
            out.setdefault(cur or "ALL", []).append(m.group(2))
    return out


def chapter_sources(ms_text=None):
    """[(name, title, raw source)] per chapter. A chapter ends at the next chapter opener, the next part page
    or the back cover, so no part-page epigraph or back-cover text leaks into a chapter (found 2026-09-24)."""
    t = ms_text if ms_text is not None else (MS.read_text() if MS.exists() else "")
    marks = [(m.start(), m.group(1), m.group(2)) for m in re.finditer(r'#chaphead\("Chapter (\w+)", "[^"]*", "([^"]+)"', t)]
    stops = sorted([m.start() for m in re.finditer(r"#partpage\(|// BACK COVER", t)] + [s for s, _, _ in marks] + [len(t)])
    out = []
    for s, name, title in marks:
        end = min(x for x in stops if x > s)
        end = t.rfind("```{=typst}", s, end) if t.rfind("```{=typst}", s, end) > s else end  # drop the next block's opening fence
        out.append((name, title, t[s:end]))
    return out


CHAPTERS = chapters()
PARTS = parts()

if __name__ == "__main__":
    if "--shell" in sys.argv:
        for k, v in [("BOOK_ID", BOOK_ID), ("BOOK_DIR", BOOK_DIR), ("MS", MS), ("TEMPLATE", TEMPLATE), ("DATA", DATA),
                     ("QA", QA), ("RELEASES", RELEASES), ("FONT_DIR_1", FONTS[0] if FONTS else ""),
                     ("FONT_DIR_2", FONTS[1] if len(FONTS) > 1 else FONTS[0] if FONTS else ""),
                     ("PANDOC_FLAGS", " ".join(PANDOC_FLAGS)), ("TYPST_FLAGS", " ".join(TYPST_FLAGS)),
                     ("CHAPTERS", ",".join(CHAPTERS))]:
            print(f'{k}="{v}"')
    else:
        print(json.dumps({"book": BOOK_ID, "manuscript": str(MS), "qa": str(QA), "chapters": CHAPTERS}, indent=1))
