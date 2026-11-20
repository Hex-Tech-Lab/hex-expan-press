"""Build a public web preview PDF + cover image from a book's built PDF.

Reuses book_config.py (books/<id>.json) and parse_pages() from flipbook_build.py
so page selection and output paths stay driven by the book identity file.
Never copies the full paid PDF: extracts only the curated preview pages and
re-distills through Ghostscript (stripping broken Tagged-PDF /StructTreeRoot
references per AGENTS.md and compressing images for web delivery).

Usage:
    BOOK=duane .tools/pdfenv/bin/python scripts/preview_pdf_build.py \\
        --source data/intel/duane_book/releases/2026-09-24_v6.8/duane_full_v6.8.pdf
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load_book_cfg(book_id: str) -> dict:
    return json.loads((REPO / "books" / f"{book_id}.json").read_text(encoding="utf-8"))


def build_preview_pdf(source_pdf: Path, pages_spec: str, out_pdf: Path, gs_preset: str = "/ebook") -> int:
    import pdfplumber
    import pikepdf

    scripts_dir = str(REPO / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from flipbook_build import parse_pages

    with pdfplumber.open(source_pdf) as probe:
        total = len(probe.pages)
    wanted = list(parse_pages(pages_spec, total))
    if not wanted:
        raise ValueError(f"No pages matched spec {pages_spec!r} for {source_pdf} ({total} pages)")

    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
        tmp_raw = Path(tf.name)
    try:
        with pikepdf.open(source_pdf) as src:
            dst = pikepdf.Pdf.new()
            for p in wanted:
                dst.pages.append(src.pages[p - 1])
            dst.save(tmp_raw)

        gs_bin = shutil.which("gs")
        if not gs_bin:
            raise RuntimeError("Ghostscript (gs) is required to re-distill extracted preview PDFs")

        subprocess.run(
            [
                gs_bin,
                "-sDEVICE=pdfwrite",
                "-dCompatibilityLevel=1.7",
                f"-dPDFSETTINGS={gs_preset}",
                "-dNOPAUSE",
                "-dQUIET",
                "-dBATCH",
                f"-sOutputFile={out_pdf}",
                str(tmp_raw),
            ],
            check=True,
        )
    finally:
        if tmp_raw.exists():
            os.unlink(tmp_raw)

    with pdfplumber.open(out_pdf) as verify:
        if len(verify.pages) != len(wanted):
            raise RuntimeError(f"Expected {len(wanted)} pages in {out_pdf}, got {len(verify.pages)}")
    return len(wanted)


def render_cover_image(source_pdf: Path, out_image: Path, width_px: int = 600) -> None:
    import pdfplumber

    out_image.parent.mkdir(parents=True, exist_ok=True)
    with pdfplumber.open(source_pdf) as pdf:
        page = pdf.pages[0]
        dpi = max(72, round((width_px / float(page.width)) * 72))
        im = page.to_image(resolution=dpi).original.convert("RGB")
        if out_image.suffix.lower() in {".jpg", ".jpeg"}:
            im.save(out_image, "JPEG", quality=88, optimize=True)
        else:
            im.save(out_image, "PNG", optimize=True)


def main() -> None:
    book_id = os.environ.get("BOOK", "duane")
    cfg = load_book_cfg(book_id)

    ap = argparse.ArgumentParser(description="Build public preview PDF (and optional cover) from a built book PDF.")
    ap.add_argument("--source", type=Path, help="Source PDF path (defaults to latest current.pdf under cfg.data_dir)")
    ap.add_argument("--pages", default=cfg.get("preview_pages", ""), help="1-based page spec, e.g. 1,3,5,7-13,15,99")
    ap.add_argument("--out-pdf", type=Path, help="Output PDF path (defaults to web/public + cfg.preview_pdf)")
    ap.add_argument("--out-cover", type=Path, help="Optional output cover image path rendered from page 1")
    ap.add_argument("--gs-preset", default="/ebook", choices=["/screen", "/ebook", "/printer", "/prepress"])
    args = ap.parse_args()

    source = args.source
    if source is None:
        data_dir = cfg.get("data_dir")
        if not data_dir:
            raise SystemExit("Missing --source and book config has no data_dir")
        candidate = REPO / data_dir / "releases" / "current.pdf"
        if not candidate.exists():
            raise SystemExit(f"Missing --source and no default at {candidate}")
        source = candidate
    source = source.resolve()

    out_pdf = args.out_pdf
    if out_pdf is None:
        rel = cfg.get("preview_pdf")
        if not rel or not str(rel).startswith("/"):
            raise SystemExit("Book config missing preview_pdf (or pass --out-pdf)")
        out_pdf = REPO / "web" / "public" / str(rel).lstrip("/")

    n = build_preview_pdf(source, args.pages, out_pdf, gs_preset=args.gs_preset)
    print(f"built preview PDF: {out_pdf} ({n} pages, {out_pdf.stat().st_size} bytes)")

    if args.out_cover:
        render_cover_image(source, args.out_cover)
        print(f"rendered cover image: {args.out_cover} ({args.out_cover.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
