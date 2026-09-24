"""Apply Jev-checked trims (ACCEPT/FLAG only) to manuscript.md, with optional fill-back.

Usage: trim_apply.py <trims_checked.json>... [--fillback --page N --marker "<text>"]
                     [--manuscript <path-to-copy>]

Fill-back: after applying trims, try reverting each applied trim one at a time
(lowest jev.meaning_kept first — the trims that cost the most meaning come back
first). Rebuild the book (pandoc+typst, same as scripts/book_build.sh) and keep
the revert only if the marker text is still on PDF page N; else undo it.
"""
import argparse, json, shutil, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOOK = ROOT / "manuscript/book"
MS = BOOK / "manuscript.md"
PANDOC = ROOT / ".tools/pandoc/bin/pandoc"
TYPST = ROOT / ".tools/typst-0.15.1/typst"
FONTS = [ROOT / "typst_prototype/fonts", ROOT / "typst_prototype/fonts_variable"]
PDFENV_PY = ROOT / ".tools/pdfenv/bin/python"
FILLBACK_DIR = ROOT / "data/intel/duane_book/qa/trim/fillback"
EXP_MD = BOOK / "exp_t28.md"
EXP_TYP = BOOK / "build_t28.typ"


def build_and_page_check(md_path: Path, out_pdf: Path, marker: str, page: int) -> bool:
    """Compile md_path with pandoc+typst (mirrors scripts/book_build.sh), then
    return True if marker text appears on PDF page `page` (whitespace-normalized)."""
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [str(PANDOC), str(md_path), "--to", "typst", "--wrap=none", "--shift-heading-level-by=-1",
         "--template=template.typ", "-o", str(EXP_TYP)],  # keep in step with scripts/book_build.sh
        cwd=BOOK, check=True, capture_output=True, text=True)
    subprocess.run(
        [str(TYPST), "compile", "--pdf-standard", "ua-1", "--font-path", str(FONTS[0]),
         "--font-path", str(FONTS[1]), str(EXP_TYP), str(out_pdf)],
        cwd=BOOK, check=True, capture_output=True, text=True)
    code = (
        "import sys, pdfplumber\n"
        "marker, page, pdf_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]\n"
        "with pdfplumber.open(pdf_path) as pdf:\n"
        "    if page < 1 or page > len(pdf.pages):\n"
        "        print('PAGE_OUT_OF_RANGE'); sys.exit()\n"
        "    txt = pdf.pages[page - 1].extract_text() or ''\n"
        "norm = lambda s: ' '.join(s.split())\n"
        "print('YES' if norm(marker) in norm(txt) else 'NO')\n")
    r = subprocess.run([str(PDFENV_PY), "-c", code, marker, str(page), str(out_pdf)],
                       capture_output=True, text=True)
    if r.returncode != 0 or "PAGE_OUT_OF_RANGE" in r.stdout:
        raise SystemExit(f"marker check failed: {r.stdout.strip()} {r.stderr.strip()}")
    return "YES" in r.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("trims", nargs="*", help="trims_checked.json files")
    ap.add_argument("--manuscript", help="path to a manuscript COPY to trim (default: manuscript.md)")
    ap.add_argument("--fillback", action="store_true")
    ap.add_argument("--page", type=int)
    ap.add_argument("--marker")
    args = ap.parse_args()

    if args.fillback and (not args.page or not args.marker):
        ap.error("--fillback requires --page and --marker")

    target = Path(args.manuscript) if args.manuscript else MS
    t = target.read_text()

    applied = []
    for f in args.trims:
        for tr in json.loads(Path(f).read_text()):
            v = tr.get("jev", {}).get("verdict")
            if v not in ("ACCEPT", "FLAG"):
                print(f"skip {tr['id']} ({v})"); continue
            if t.count(tr["old"]) != 1:
                print(f"skip {tr['id']} (old not unique/found)"); continue
            t = t.replace(tr["old"], tr["new"]); print(f"applied {tr['id']} ({v})")
            applied.append(tr)

    if not args.fillback:
        target.write_text(t)
        return

    # Fill-back needs a stable working copy inside manuscript/book for the build.
    EXP_MD.write_text(t)  # the trimmed text, not the file on disk
    out_pdf = FILLBACK_DIR / (EXP_MD.stem + f"_p{args.page}.pdf")
    table = []
    if not build_and_page_check(EXP_MD, out_pdf, args.marker, args.page):
        print(f"baseline: marker NOT on page {args.page} even with all trims applied — nothing to fill back")
    else:
        for tr in sorted(applied, key=lambda x: x["jev"]["meaning_kept"]):
            if t.count(tr["new"]) != 1:
                table.append((tr["id"], "no")); continue
            cand = t.replace(tr["new"], tr["old"])
            EXP_MD.write_text(cand)
            if build_and_page_check(EXP_MD, out_pdf, args.marker, args.page):
                t = cand
                table.append((tr["id"], "yes"))
            else:
                table.append((tr["id"], "no"))
        target.write_text(t)
    if EXP_MD.resolve() != target.resolve():
        EXP_MD.unlink(missing_ok=True)

    print("\ntrim id | reverted")
    for tid, yn in table:
        print(f"{tid} | {yn}")
    print(f"\nfinal pdf: {out_pdf}")


if __name__ == "__main__":
    main()
