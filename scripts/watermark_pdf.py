#!/usr/bin/env python3
"""
scripts/watermark_pdf.py  -  PDF Visual Watermarking & Cryptographic Provenance Fingerprinting

Applies a semi-transparent diagonal watermark across every page of an asset PDF and injects
an HMAC-SHA256 digital fingerprint into the PDF metadata dictionary.

Usage:
  python3 scripts/watermark_pdf.py \
    --input data/intel/duane_book/releases/current.pdf \
    --output data/intel/duane_book/releases/current.review_watermarked.pdf \
    --creator-id "retirearly500k" \
    --creator-name "Duane Smith" \
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
import pypdf

FINGERPRINT_SALT = os.environ.get("ASSET_SALT", "")


def generate_overlay_pdf(width: float, height: float, text: str) -> bytes:
    """Generates an in-memory 1-page PDF stream containing diagonal watermark text."""
    cx = width / 2.0
    cy = height / 2.0
    
    # 40-degree angle for standard 6x9 or Letter aspect ratio
    angle_rad = math.radians(38)
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)
    
    # Center text roughly
    font_size = 11.5
    approx_text_width = len(text) * (font_size * 0.52)
    tx = cx - (approx_text_width / 2.0) * cos_a
    ty = cy - (approx_text_width / 2.0) * sin_a

    # Escape PDF text parentheses
    safe_text = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    # PDF Stream with light gray 0.72 color (unobtrusive reading, clear repro)
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

    # Valid standalone PDF 1.4
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


def main():
    parser = argparse.ArgumentParser(description="Stamp visual watermark and HMAC metadata fingerprint on PDF assets.")
    parser.add_argument("--input", required=True, help="Path to source PDF")
    parser.add_argument("--output", required=True, help="Path to destination watermarked PDF")
    parser.add_argument("--creator-id", required=True, help="Creator identifier (e.g. retirearly500k)")
    parser.add_argument("--creator-name", required=True, help="Creator full legal name (e.g. Duane Smith)")
    parser.add_argument("--purpose", choices=["review", "author_copy"], default="review",
                        help="'review' for pre-publication reviewer copy, 'author_copy' for registered author copy")

    args = parser.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"Error: input file does not exist: {args.input}")

    # Build provenance fingerprint
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    fingerprint_payload = f"{args.creator_id}:{args.creator_name}:{args.purpose}:{timestamp}"
    hmac_digest = hmac.new(
        FINGERPRINT_SALT.encode("utf-8"),
        fingerprint_payload.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

    # Select visible watermark copy
    if args.purpose == "review":
        watermark_text = f"CONFIDENTIAL REVIEW COPY  -  {args.creator_name.upper()}  -  NOT FOR DISTRIBUTION"
    else:
        watermark_text = f"REGISTERED AUTHOR COPY  -  {args.creator_name.upper()}  -  EXPANPRESS"

    reader = pypdf.PdfReader(args.input)
    writer = pypdf.PdfWriter()

    overlay_cache = {}

    for idx, page in enumerate(reader.pages):
        mb = page.mediabox
        width = float(mb.width)
        height = float(mb.height)
        key = (round(width), round(height))

        if key not in overlay_cache:
            overlay_pdf_bytes = generate_overlay_pdf(width, height, watermark_text)
            overlay_reader = pypdf.PdfReader(io.BytesIO(overlay_pdf_bytes))
            overlay_cache[key] = overlay_reader.pages[0]

        # Merge visual watermark into page
        page.merge_page(overlay_cache[key])
        writer.add_page(page)

    # Ingest / Preserve existing metadata while adding security provenance
    existing_meta = reader.metadata or {}
    new_meta = {
        "/Producer": "ExpanPress Asset Security Engine",
        "/Author": args.creator_name,
        "/ProvenanceId": hmac_digest[:16],
        "/ProvenanceFingerprint": hmac_digest,
        "/ProvenanceTimestamp": timestamp,
        "/ProvenanceCreatorId": args.creator_id,
        "/ProvenancePurpose": args.purpose,
        "/Keywords": f"expanpress;{args.creator_id};{args.purpose};{hmac_digest[:16]}"
    }
    if "/Title" in existing_meta:
        new_meta["/Title"] = str(existing_meta["/Title"])

    writer.add_metadata(new_meta)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "wb") as f_out:
        writer.write(f_out)

    print(f"Successfully created watermarked PDF: {args.output}")
    print(f"Pages: {len(writer.pages)} | Fingerprint: {hmac_digest[:16]}... | Timestamp: {timestamp}")


if __name__ == "__main__":
    main()
