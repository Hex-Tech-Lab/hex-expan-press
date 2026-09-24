"""Render a built book PDF into a static, local page-flip preview (StPageFlip via jsdelivr only).

    .tools/pdfenv/bin/python scripts/flipbook_build.py <pdf> [--pages 1-20] [--dpi 110]

Output: <pdf's dir>/flipbook/pages/pNNN.jpg + flipbook/index.html.
Pages/chapters/paths come from the PDF path + book_config.py; never hard-code a book.
"""
import argparse
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
from book_config import DATA, QA, RELEASES  # noqa: E402


def parse_pages(spec: str, total: int) -> range:
    if not spec:
        return range(1, total + 1)
    out = set()
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(part))
    return sorted(p for p in out if 1 <= p <= total)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--pages", default="")
    ap.add_argument("--dpi", type=int, default=110)
    args = ap.parse_args()

    import pdfplumber
    from PIL import Image

    pdf_path = args.pdf.resolve()
    out_dir = pdf_path.parent / "flipbook"
    pages_dir = out_dir / "pages"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    pages_dir.mkdir(parents=True)

    with pdfplumber.open(pdf_path) as pdf:
        total = len(pdf.pages)
        wanted = parse_pages(args.pages, total)
        names = []
        for i in wanted:
            im = pdf.pages[i - 1].to_image(resolution=args.dpi).original
            name = f"p{i:03d}.jpg"
            im.convert("RGB").save(pages_dir / name, "JPEG", quality=82)
            names.append(name)
            if i % 25 == 0:
                print(f"  rendered {i}/{total}")
    for nm in names:
        print(nm)
    print(f"total: {len(names)} pages -> {pages_dir}")

    last = wanted[-1]
    html = INDEX_HTML.format(n=last, total=total, pages=",".join(f'"{p}"' for p in names))
    (out_dir / "index.html").write_text(html)
    print(f"wrote {out_dir / 'index.html'}")


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book preview</title>
<style>
  html,body {{ margin:0; height:100%; background:#2a2a2a; color:#ddd;
    font-family: Georgia, 'Times New Roman', serif; }}
  #note {{ text-align:center; padding:10px 0 2px; font-size:14px; color:#aaa; }}
  #controls {{ text-align:center; padding:4px 0 10px; }}
  button {{ background:#444; color:#ddd; border:1px solid #666; border-radius:4px;
    padding:6px 14px; margin:0 6px; font-size:14px; cursor:pointer; }}
  button:hover {{ background:#555; }}
  #spread {{ display:flex; justify-content:center; }}
  #book {{ }}
  @media (max-width: 700px) {{
    #book {{ width: 90vw !important; }}
  }}
</style>
</head>
<body>
<p id="note">Preview &mdash; pages 1&ndash;{n} (of {total})</p>
<div id="spread"><div id="book"></div></div>
<div id="controls">
  <button id="prev">&#8592; Prev</button>
  <button id="next">Next &#8594;</button>
</div>
<script src="https://cdn.jsdelivr.net/npm/page-flip/dist/js/page-flip.browser.js"></script>
<script>
const pages = [{pages}];
const isNarrow = window.matchMedia('(max-width: 700px)').matches;
const w = isNarrow ? Math.min(560, window.innerWidth * 0.9) : 480;
const h = Math.round(w * 1.5);
const pf = new St.PageFlip(document.getElementById('book'), {{
  width: w, height: h, size: 'fixed', showCover: true,
  maxPageShadow: 0, usePortrait: isNarrow,
}});
pf.loadFromImages(pages);
document.getElementById('prev').onclick = () => pf.flipPrev();
document.getElementById('next').onclick = () => pf.flipNext();
document.addEventListener('keydown', (e) => {{
  if (e.key === 'ArrowLeft') pf.flipPrev();
  if (e.key === 'ArrowRight') pf.flipNext();
}});
</script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
