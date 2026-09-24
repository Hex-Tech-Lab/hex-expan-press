#!/usr/bin/env python3
"""Visual regression for approved chapters (ADR 0043 §6).
Renders each page of a chapter and compares it pixel-by-pixel with the approved baseline.
  compare: visual_regress.py --pdf proof.pdf --chapters One,Four
  approve: visual_regress.py --pdf proof.pdf --chapters One,Four --approve   (founder sign-off only)
Fails (exit 3) if a page changed beyond tolerance or the page count changed; writes red-overlay
diffs to <QA>/visual_diff/<Chapter>/. Chapters without a baseline are skipped.
"""
import argparse, hashlib, json, shutil, subprocess, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageChops
import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA  # noqa: E402
from book_qa import pdf_chapter_ranges  # noqa: E402

DPI, PIXEL_DELTA, MAX_CHANGED = 100, 24, 0.0005  # 0.05% of pixels may differ (anti-aliasing noise)


def render(pdf, first, last, out):
    subprocess.run(["pdftoppm", "-r", str(DPI), "-f", str(first), "-l", str(last), "-png", pdf, str(out / "p")],
                   check=True, stderr=subprocess.DEVNULL)
    return sorted(out.glob("p-*.png"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--chapters", required=True)
    ap.add_argument("--approve", action="store_true")
    a = ap.parse_args()
    ranges = pdf_chapter_ranges(pdfplumber.open(a.pdf))
    failed = False
    for ch in a.chapters.split(","):
        ch_failed_before = failed
        failed = False
        if ch not in ranges:
            print(f"visual: chapter {ch} not found in PDF"); failed = True; continue
        base = QA / "baseline" / ch
        with tempfile.TemporaryDirectory() as t:
            pages = render(a.pdf, *ranges[ch], Path(t))
            if a.approve:
                shutil.rmtree(base, ignore_errors=True); base.mkdir(parents=True)
                for i, p in enumerate(pages, 1):
                    shutil.copy(p, base / f"p{i:02d}.png")
                (base / "manifest.json").write_text(json.dumps({
                    "approved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "source_pdf": Path(a.pdf).name, "pdf_pages": ranges[ch],
                    "pdf_md5": hashlib.md5(Path(a.pdf).read_bytes()).hexdigest(), "pages": len(pages)}, indent=1))
                print(f"visual: Chapter {ch} baseline approved ({len(pages)} pages)")
                continue
            if not base.exists():
                print(f"visual: Chapter {ch} has no approved baseline — skipped"); continue
            want = sorted(base.glob("p*.png"))
            if len(want) != len(pages):
                print(f"visual FAIL: Chapter {ch} page count {len(pages)} != baseline {len(want)}"); failed = True
            diffdir = QA / "visual_diff" / ch
            shutil.rmtree(diffdir, ignore_errors=True)
            for i, (w, g) in enumerate(zip(want, pages), 1):
                A, B = Image.open(w).convert("RGB"), Image.open(g).convert("RGB")
                if A.size != B.size:
                    print(f"visual FAIL: Chapter {ch} p{i} size changed"); failed = True; continue
                mask = ImageChops.difference(A, B).convert("L").point(lambda v: 255 if v > PIXEL_DELTA else 0)
                frac = sum(1 for v in mask.get_flattened_data() if v) / (A.size[0] * A.size[1])
                if frac > MAX_CHANGED:
                    failed = True
                    diffdir.mkdir(parents=True, exist_ok=True)
                    over = B.copy(); over.paste((220, 0, 0), mask=mask); over.save(diffdir / f"p{i:02d}.png")
                    print(f"visual FAIL: Chapter {ch} p{i} (book p{ranges[ch][0] + i - 1}) {frac:.2%} of pixels changed -> {diffdir / f'p{i:02d}.png'}")
            if not failed:
                print(f"visual: Chapter {ch} matches baseline ({len(pages)} pages)")
        failed = failed or ch_failed_before
    sys.exit(3 if failed else 0)


if __name__ == "__main__":
    main()
