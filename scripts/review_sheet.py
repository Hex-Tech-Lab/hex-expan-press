#!/usr/bin/env python3
"""T23: visual review sheet of every opener, box, photo page and cover.

Usage:
  .tools/pdfenv/bin/python scripts/review_sheet.py --pdf <book.pdf> --out <dir>
"""
import argparse
import os
import re

import pdfplumber
from PIL import Image, ImageDraw, ImageFont

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import CHAPTERS


def classify(page, n, total):
    text = page.extract_text() or ""
    flat = re.sub(r"\s+", "", text)
    if n == 1:
        return "cover"
    if n == total:
        return "back-cover"
    if "PART" in flat:
        return "part"
    if "CHAPTER" in flat:
        return "opener"
    ph = float(page.height)
    for r in page.rects + page.curves:
        w = float(r["x1"]) - float(r["x0"])
        h = float(r["bottom"]) - float(r["top"])
        if w > 200 and h > 60 and h < 600:
            return "box"
    return "other"


ROMAN = re.compile(r"^[ivxlcdm]+$")


def folio(page):
    words = page.extract_words()
    bottom = [w for w in words if float(w["top"]) > float(page.height) - 60]
    for w in bottom:
        t = w["text"].strip()
        if t.isdigit() or ROMAN.match(t):
            return t
    return "—"


def side(idx):
    return "recto" if (idx + 1) % 2 == 1 else "verso"


def chapter_name(page):
    text = page.extract_text() or ""
    flat = re.sub(r"(?<=[A-Z]) (?=[A-Z])", "", text)  # kicker is letter-spaced: "C H A P T E R  N I N E"
    m = re.search(r"CHAPTER\s*(" + "|".join(CHAPTERS) + ")", flat)
    return f"Chapter {m.group(1).title()}" if m else None


def render(pdf, pages, dpi=60, per_row=4, tile_w=488, tile_h=660, out_path=None):
    n = len(pages)
    rows = (n + per_row - 1) // per_row
    cols = min(per_row, n) or 1
    sheet = Image.new("RGB", (cols * tile_w, rows * tile_h), "white")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    for i, (idx, cls, fol, sd, chap) in enumerate(pages):
        r, c = divmod(i, per_row)
        im = pdf.pages[idx].to_image(resolution=dpi).original.convert("RGB")
        im.thumbnail((tile_w - 8, tile_h - 28))
        x, y = c * tile_w, r * tile_h
        draw.rectangle([x, y, x + tile_w, y + 22], fill="black")
        draw.text((x + 4, y + 4), f"PDF p{idx+1} · folio {fol} · {sd} · {chap or cls}",
                  fill="white", font=font)
        sheet.paste(im, (x + 4, y + 26))
        draw.rectangle([x, y, x + tile_w - 1, y + tile_h - 1],
                       outline="#bbbbbb")
    sheet.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    pdf = pdfplumber.open(args.pdf)
    total = len(pdf.pages)
    info = []
    for i, page in enumerate(pdf.pages):
        cls = classify(page, i + 1, total)
        chap = chapter_name(page) if cls == "opener" else None
        info.append((i, cls, folio(page), side(i), chap))

    covers = [x for x in info if x[1] in ("cover", "back-cover", "part")]
    openers = [x for x in info if x[1] == "opener"]
    boxes = [x for x in info if x[1] == "box"]

    tiles_openers = covers + openers
    render(pdf, tiles_openers, out_path=os.path.join(args.out, "openers.png"))
    render(pdf, boxes, out_path=os.path.join(args.out, "boxes.png"))

    with open(os.path.join(args.out, "index.md"), "w") as f:
        f.write("# Review sheet index\n\n")
        f.write(f"PDF: `{args.pdf}` · {total} pages\n\n")
        f.write("## Contact sheets\n\n")
        f.write("- `openers.png` — cover, part pages, chapter openers, "
                "back cover\n")
        f.write("- `boxes.png` — box pages\n\n")
        f.write("## All classified pages\n\n")
        f.write("| pdf page | class | folio | side | chapter |\n|---|---|---|---|---|\n")
        for idx, cls, fol, sd, chap in info:
            if cls != "other":
                f.write(f"| {idx+1} | {cls} | {fol} | {sd} | {chap or ''} |\n")
        f.write("\n## All pages (incl. other)\n\n")
        f.write("| pdf page | class | folio | side |\n|---|---|---|---|\n")
        for idx, cls, fol, sd, chap in info:
            f.write(f"| {idx+1} | {cls} | {fol} | {sd} |\n")
    pdf.close()
    print(f"classified: {len(covers)} cover/part, {len(openers)} openers, "
          f"{len(boxes)} box pages")


if __name__ == "__main__":
    main()
