#!/usr/bin/env python3
"""
scripts/watermark_pdf.py  -  PDF Visual Watermarking & Cryptographic Provenance Fingerprinting

Supports dual operation modes:
1. 'diagonal': Semi-transparent diagonal body watermark for media assets and e-book review/author copies.
2. 'perimeter': Clean legal header/footer perimeter audit stamp for contracts (C1 Consents, C2 Releases,
   C3 Publisher Agreements) that preserves courtroom admissibility and never obscures text.

Injects unified Merkle Bundle provenance metadata (/BundleId, /BundleRootHash, /ProvenanceFingerprint)
into the PDF catalog dictionary.

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
import math
import os
import sys
import pypdf

# bundle_salt sits beside this script. Put this directory on the path so the import also works when the
# script is loaded by path (as the tests do) rather than run directly.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from bundle_salt import fingerprint_salt  # noqa: E402

# Contract purposes take perimeter stamps only; diagonal body watermarks never touch legal text.
CONTRACT_PURPOSES = frozenset({"c1_data_accuracy", "c2_release_approval", "c3_agreement", "legal_contract"})
# Non-contract purposes. --purpose accepts exactly CONTRACT_PURPOSES plus these, so the two cannot drift apart.
NON_CONTRACT_PURPOSES = frozenset({"review", "author_copy"})
PURPOSES = tuple(sorted(CONTRACT_PURPOSES | NON_CONTRACT_PURPOSES))


def compute_sha256(filepath: str) -> str:
    """Computes SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


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

    safe_text = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    content = f"""q
0.72 0.72 0.72 rg
BT
/F1 {font_size:.1f} Tf
{cos_a:.4f} {sin_a:.4f} {-sin_a:.4f} {cos_a:.4f} {tx:.2f} {ty:.2f} Tm
({safe_text}) Tj
ET
Q
"""
    stream_bytes = content.encode("utf-8")
    stream_len = len(stream_bytes)

    pdf_str = f"""%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2f} {height:.2f}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj
5 0 obj << /Length {stream_len} >>
stream
{content}endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000250 00000 n 
0000000333 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
{350 + stream_len}
%%EOF"""
    return pdf_str.encode("latin-1")


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

    safe_header = header_text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    safe_footer = footer_text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

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
    stream_bytes = content.encode("utf-8")
    stream_len = len(stream_bytes)

    pdf_str = f"""%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 {width:.2f} {height:.2f}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length {stream_len} >>
stream
{content}endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000250 00000 n 
0000000333 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
{350 + stream_len}
%%EOF"""
    return pdf_str.encode("latin-1")


def main():
    parser = argparse.ArgumentParser(description="Stamp visual watermark and HMAC metadata fingerprint on PDF assets/contracts.")
    parser.add_argument("--input", required=True, help="Path to source PDF")
    parser.add_argument("--output", required=True, help="Path to destination watermarked PDF")
    parser.add_argument("--creator-id", required=True, help="Creator identifier (e.g. example-creator)")
    parser.add_argument("--creator-name", required=True, help="Creator full legal name (e.g. the owner)")
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
    parser.add_argument("--bundle-root-hash", default=None, help="Merkle root hash of the complete bundle")

    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"Error: input file does not exist: {args.input}")
    if os.path.abspath(args.output) == os.path.abspath(args.input):
        sys.exit("Error: --output must differ from --input; refusing to overwrite the source PDF")
    if args.mode == "diagonal" and args.purpose in CONTRACT_PURPOSES:
        sys.exit(
            f"Error: diagonal stamping is refused for contract purpose '{args.purpose}'; "
            "contracts take perimeter stamps only"
        )

    # Compute source file hash
    source_sha256 = compute_sha256(args.input)

    # Establish or derive Bundle ID
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    date_slug = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    bundle_id = args.bundle_id or f"BND-{date_slug}-{args.creator_id[:12].upper()}-{source_sha256[:8].upper()}"

    # Build provenance fingerprint
    fingerprint_payload = f"{bundle_id}:{args.creator_id}:{args.creator_name}:{args.purpose}:{source_sha256}:{timestamp}"
    hmac_digest = hmac.new(
        fingerprint_salt(),
        fingerprint_payload.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

    bundle_root = args.bundle_root_hash or hmac_digest

    reader = pypdf.PdfReader(args.input)
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

    # Ingest / Preserve existing metadata while adding security provenance
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

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "wb") as f_out:
        writer.write(f_out)

    print(f"Successfully created watermarked PDF: {args.output}")
    print(f"Mode: {args.mode.upper()} | Bundle: {bundle_id} | Pages: {len(writer.pages)} | Fingerprint: {hmac_digest[:16]}...")


if __name__ == "__main__":
    main()
