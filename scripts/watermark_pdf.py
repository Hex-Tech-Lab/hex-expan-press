#!/usr/bin/env python3
"""
scripts/watermark_pdf.py  -  PDF Visual Watermarking & Cryptographic Provenance Fingerprinting

Supports dual operation modes:
1. 'diagonal': Light-gray diagonal body watermark for media assets and e-book review/author copies.
2. 'perimeter': Header and footer audit stamp for contracts (C1 Consents, C2 Releases, C3 Publisher
   Agreements). It is drawn at fixed offsets from the top and bottom edges. A page with text in those
   bands is refused, so the stamp never covers legal text. Images and vector drawings in the bands are
   not detected.

Writes unified bundle provenance metadata (/BundleId, /BundleRootHash, /ProvenanceFingerprint) into the
PDF document information dictionary.

Usage:
  python3 scripts/watermark_pdf.py \
    --input data/intel/duane_book/releases/current.pdf \
    --output data/intel/duane_book/releases/current.review_watermarked.pdf \
    --creator-id "example-creator" \
    --creator-name "the owner" \
    --mode "diagonal" \
    --purpose "review"
"""

import argparse
import datetime
import hashlib
import hmac
import io
import json
import math
import os
import sys
import tempfile
import pypdf

# bundle_salt sits beside this script. Put this directory on the path so the import also works when the
# script is loaded by path (as the tests do) rather than run directly.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from bundle_salt import fingerprint_salt  # noqa: E402

# Contract purposes take perimeter stamps only. main() refuses diagonal stamping for these purposes.
CONTRACT_PURPOSES = frozenset({"c1_data_accuracy", "c2_release_approval", "c3_agreement", "legal_contract"})
# Non-contract purposes. --purpose accepts exactly CONTRACT_PURPOSES plus these, so the two cannot drift apart.
NON_CONTRACT_PURPOSES = frozenset({"review", "author_copy"})
PURPOSES = tuple(sorted(CONTRACT_PURPOSES | NON_CONTRACT_PURPOSES))
# The perimeter stamp is drawn within 26 pt of the top and bottom edges. Text in those bands would be covered.
STAMP_BAND_PT = 30.0


def overlay_text(text: str) -> str:
    """Text for a PDF string in an overlay stream. The stream is Latin-1. A character outside it raises ValueError
    instead of being replaced, because a substituted character would put a wrong name on the stamp."""
    try:
        text.encode("latin-1")
    except UnicodeEncodeError as exc:
        raise ValueError(
            f"stamp text contains {exc.object[exc.start:exc.end]!r}, which is outside Latin-1 and cannot be shown; "
            "refusing to stamp a substituted name"
        ) from None
    return text


def _single_page_pdf(width: float, height: float, base_font: str, content: str) -> bytes:
    """A one-page PDF around one Latin-1 content stream. Every xref offset is measured from the bytes written, so the
    table and startxref always name the objects they point at."""
    stream = content.encode("latin-1")  # /Length counts the bytes actually emitted
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2f} {height:.2f}] "
         "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>").encode("latin-1"),
        f"<< /Type /Font /Subtype /Type1 /BaseFont /{base_font} >>".encode("latin-1"),
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(bodies, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref_at = len(out)
    size = len(bodies) + 1
    out += b"xref\n0 %d\n" % size
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n" % (size, xref_at)
    out += b"%%EOF\n"
    return bytes(out)


def generate_diagonal_overlay_pdf(width: float, height: float, text: str) -> bytes:
    """Generates an in-memory 1-page PDF stream containing diagonal watermark text."""
    cx = width / 2.0
    cy = height / 2.0

    angle_rad = math.radians(38)
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)

    font_size = 11.5
    approx_text_width = len(text) * (font_size * 0.52)
    tx = cx - (approx_text_width / 2.0) * cos_a
    ty = cy - (approx_text_width / 2.0) * sin_a

    safe_text = overlay_text(text).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    content = f"""q
0.72 0.72 0.72 rg
BT
/F1 {font_size:.1f} Tf
{cos_a:.4f} {sin_a:.4f} {-sin_a:.4f} {cos_a:.4f} {tx:.2f} {ty:.2f} Tm
({safe_text}) Tj
ET
Q
"""
    return _single_page_pdf(width, height, "Helvetica-Bold", content)


def generate_perimeter_overlay_pdf(
    width: float,
    height: float,
    bundle_id: str,
    doc_hash_short: str,
    creator_name: str,
    page_num: int,
    total_pages: int
) -> bytes:
    """Generates an in-memory 1-page PDF stream containing clean perimeter header & footer audit stamps."""
    margin_x = 36.0
    top_y = height - 22.0
    line_top_y = height - 26.0
    bottom_y = 16.0
    line_bottom_y = 26.0

    header_text = f"EXPANPRESS EXECUTION BUNDLE  |  BUNDLE ID: {bundle_id}  |  LEGAL PROVENANCE HOLD"
    footer_text = f"Digitally Sealed & Fingerprinted  |  Doc SHA-256: {doc_hash_short}...  |  Page {page_num} of {total_pages}  |  Legal Signer: {creator_name}"

    safe_header = overlay_text(header_text).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    safe_footer = overlay_text(footer_text).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    font_size = 7.0

    content = f"""q
0.45 0.50 0.55 rg
0.45 0.50 0.55 RG
0.5 w
BT
/F1 {font_size:.1f} Tf
{margin_x:.2f} {top_y:.2f} Td
({safe_header}) Tj
ET
{margin_x:.2f} {line_top_y:.2f} m
{width - margin_x:.2f} {line_top_y:.2f} l
S
BT
/F1 {font_size:.1f} Tf
{margin_x:.2f} {bottom_y:.2f} Td
({safe_footer}) Tj
ET
{margin_x:.2f} {line_bottom_y:.2f} m
{width - margin_x:.2f} {line_bottom_y:.2f} l
S
Q
"""
    return _single_page_pdf(width, height, "Helvetica", content)


def stamp_band_text_runs(page) -> int:
    """How many text runs sit in the top or bottom STAMP_BAND_PT of the page, where the perimeter stamp is drawn.

    Only text is measured. An image or a vector drawing in those bands is not detected, so a page can pass this check
    and still have the stamp drawn over graphics.
    """
    box = page.mediabox
    bottom, top = float(box.bottom), float(box.top)
    bands = ((bottom, bottom + STAMP_BAND_PT), (top - STAMP_BAND_PT, top))
    runs = []

    def visit(text, cm, tm, font_dict, font_size):
        if not text.strip():
            return
        # The run's origin in page space: the text-space origin through the text matrix, then the current matrix.
        y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
        y_top = y + max(float(font_size or 0.0), 1.0)
        if any(y < band_hi and y_top > band_lo for band_lo, band_hi in bands):
            runs.append(text)

    page.extract_text(visitor_text=visit)
    return len(runs)


PARAM_FIELDS = ("input", "output", "creator_id", "creator_name", "mode", "purpose", "bundle_id", "bundle_root_hash")


def apply_params_file(parser, args):
    """Fills args from a JSON object file. Only the known fields are accepted, and each value must be a string or null."""
    try:
        with open(args.params, encoding="utf-8") as f_in:
            settings = json.load(f_in)
    except (OSError, ValueError) as exc:
        parser.error(f"cannot read --params {args.params}: {exc}")
    if not isinstance(settings, dict):
        parser.error("--params must hold a JSON object")
    unknown = sorted(set(settings) - set(PARAM_FIELDS))
    if unknown:
        parser.error(f"--params has unknown fields: {', '.join(unknown)}")
    for name, value in settings.items():
        if value is not None and not isinstance(value, str):
            parser.error(f"--params field {name} must be a string")
        setattr(args, name, value)


def main():
    parser = argparse.ArgumentParser(description="Stamp visual watermark and HMAC metadata fingerprint on PDF assets/contracts.")
    parser.add_argument("--input", help="Path to source PDF (required unless --params supplies it)")
    parser.add_argument("--output", help="Path to destination watermarked PDF (required unless --params supplies it)")
    parser.add_argument("--creator-id", help="Creator identifier (e.g. example-creator)")
    parser.add_argument("--creator-name", help="Creator full legal name (e.g. the owner)")
    parser.add_argument(
        "--params",
        default=None,
        metavar="JSON_FILE",
        help="Read the stamp settings from a JSON object file (keys: input, output, creator_id, creator_name, mode, "
             "purpose, bundle_id, bundle_root_hash). generate_bundle_manifest.py uses this so no value reaches argv."
    )
    parser.add_argument(
        "--mode",
        choices=["diagonal", "perimeter"],
        default="diagonal",
        help="'diagonal' for media/e-book body watermarking, 'perimeter' for legal contracts header/footer banner"
    )
    parser.add_argument(
        "--purpose",
        choices=PURPOSES,
        default="review",
        help="Classification purpose of the stamped document"
    )
    parser.add_argument("--bundle-id", default=None, help="Unified execution bundle identifier")
    parser.add_argument("--bundle-root-hash", default=None, help="HMAC root signature of the complete bundle")

    args = parser.parse_args()
    if args.params is not None:
        apply_params_file(parser, args)
    missing = [f"--{name.replace('_', '-')}" for name in ("input", "output", "creator_id", "creator_name")
               if getattr(args, name) is None]
    if missing:
        parser.error(f"the following arguments are required: {', '.join(missing)}")
    for name in ("creator_id", "creator_name"):
        if not getattr(args, name).strip():
            sys.exit(f"Error: --{name.replace('_', '-')} must not be blank; the stamp is signed with it")
    if args.mode not in ("diagonal", "perimeter") or args.purpose not in PURPOSES:
        parser.error("mode or purpose is not one of the allowed values")

    if not os.path.exists(args.input):
        sys.exit(f"Error: input file does not exist: {args.input}")
    # realpath and samefile catch a symlink or hard link to the source, not only an identical string.
    _out, _src = os.path.realpath(args.output), os.path.realpath(args.input)
    if _out == _src or (os.path.exists(args.output) and os.path.exists(args.input)
                        and os.path.samefile(args.output, args.input)):
        sys.exit("Error: --output must differ from --input; refusing to overwrite the source PDF")
    if args.mode == "diagonal" and args.purpose in CONTRACT_PURPOSES:
        sys.exit(
            f"Error: diagonal stamping is refused for contract purpose '{args.purpose}'; "
            "contracts take perimeter stamps only"
        )

    # Compute source file hash
    # Read the source once. The digest and the parsed PDF both come from this buffer, so a file replaced between
    # hashing and parsing cannot make /SourceSha256 describe different bytes.
    with open(args.input, "rb") as f_in:
        source_bytes = f_in.read()
    source_sha256 = hashlib.sha256(source_bytes).hexdigest()

    # Establish or derive Bundle ID
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    date_slug = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    bundle_id = args.bundle_id or f"BND-{date_slug}-{args.creator_id[:12].upper()}-{source_sha256[:8].upper()}"

    # Every text the stamp draws must be Latin-1. The diagonal text is upper-cased, so its form is checked too.
    # Refused here, before anything is signed or written.
    for stamp_text in (args.creator_name, args.creator_name.upper(), bundle_id):
        try:
            overlay_text(stamp_text)
        except ValueError as exc:
            sys.exit(f"Error: {exc}")

    # Build provenance fingerprint. The payload names every stamp setting that is not in the file's own bytes, and the
    # bundle root it carries, so a stamp made with a different mode or root has a different fingerprint. Nothing in this
    # script re-verifies a stamped file afterwards. The root is empty in the payload when none was supplied, and the
    # root is then the fingerprint.
    supplied_root = args.bundle_root_hash or ""
    fingerprint_payload = (f"{bundle_id}:{args.creator_id}:{args.creator_name}:{args.purpose}:{args.mode}:"
                           f"{source_sha256}:{timestamp}:{supplied_root}")
    hmac_digest = hmac.new(
        fingerprint_salt(),
        fingerprint_payload.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

    bundle_root = args.bundle_root_hash or hmac_digest

    reader = pypdf.PdfReader(io.BytesIO(source_bytes))
    writer = pypdf.PdfWriter()
    total_pages = len(reader.pages)

    if args.mode == "diagonal":
        if args.purpose == "review":
            watermark_text = f"CONFIDENTIAL REVIEW COPY  -  {args.creator_name.upper()}  -  NOT FOR DISTRIBUTION"
        else:
            watermark_text = f"REGISTERED AUTHOR COPY  -  {args.creator_name.upper()}  -  EXPANPRESS"

        overlay_cache = {}
        for idx, page in enumerate(reader.pages):
            mb = page.mediabox
            width = float(mb.width)
            height = float(mb.height)
            key = (round(width), round(height))

            if key not in overlay_cache:
                overlay_pdf_bytes = generate_diagonal_overlay_pdf(width, height, watermark_text)
                overlay_reader = pypdf.PdfReader(io.BytesIO(overlay_pdf_bytes))
                overlay_cache[key] = overlay_reader.pages[0]

            page.merge_page(overlay_cache[key])
            writer.add_page(page)

    else:  # perimeter mode
        # Every page is checked before anything is written, so a refused stamp leaves no output behind.
        for idx, page in enumerate(reader.pages):
            hits = stamp_band_text_runs(page)
            if hits:
                sys.exit(f"Error: page {idx + 1} has {hits} text run(s) in its top or bottom {STAMP_BAND_PT:.0f} pt, "
                         "where the perimeter stamp is drawn; refusing to cover legal text")
        for idx, page in enumerate(reader.pages):
            mb = page.mediabox
            width = float(mb.width)
            height = float(mb.height)

            overlay_pdf_bytes = generate_perimeter_overlay_pdf(
                width=width,
                height=height,
                bundle_id=bundle_id,
                doc_hash_short=source_sha256[:16],
                creator_name=args.creator_name,
                page_num=idx + 1,
                total_pages=total_pages
            )
            overlay_reader = pypdf.PdfReader(io.BytesIO(overlay_pdf_bytes))
            page.merge_page(overlay_reader.pages[0])
            writer.add_page(page)

    # Build the Info dictionary. Only /Title is carried over from the source. Every other source key is dropped,
    # and /Author is set to the creator name.
    existing_meta = reader.metadata or {}
    new_meta = {
        "/Producer": "ExpanPress Unified Provenance Engine",
        "/Author": args.creator_name,
        "/BundleId": bundle_id,
        "/BundleRootHash": bundle_root,
        "/ProvenanceId": hmac_digest[:16],
        "/ProvenanceFingerprint": hmac_digest,
        "/ProvenanceTimestamp": timestamp,
        "/ProvenanceCreatorId": args.creator_id,
        "/ProvenancePurpose": args.purpose,
        "/DocumentMode": args.mode,
        "/SourceSha256": source_sha256,
        "/Keywords": f"expanpress;{bundle_id};{args.creator_id};{args.purpose};{hmac_digest[:16]}"
    }
    if "/Title" in existing_meta:
        new_meta["/Title"] = str(existing_meta["/Title"])

    writer.add_metadata(new_meta)

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    # Written beside the output and renamed into place. An existing file at the output path is replaced, never written
    # through, so a symlink there is replaced by the new file and its target is left alone.
    fd, tmp_path = tempfile.mkstemp(prefix=".watermark_", suffix=".tmp", dir=out_dir)
    try:
        with os.fdopen(fd, "wb") as f_out:
            writer.write(f_out)
        os.replace(tmp_path, args.output)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise

    print(f"Successfully created watermarked PDF: {args.output}")
    print(f"Mode: {args.mode.upper()} | Bundle: {bundle_id} | Pages: {len(writer.pages)} | Fingerprint: {hmac_digest[:16]}...")


if __name__ == "__main__":
    main()
