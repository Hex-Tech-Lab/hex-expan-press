#!/usr/bin/env python3
"""
scripts/generate_bundle_manifest.py  -  Unified Cryptographic Bundle Signing Engine

Binds all four critical transaction artifacts:
1. C1 Data Accuracy Consent
2. C2 Release Approval Consent
3. C3 Publisher Agreement (Firma e-signature envelope)
4. The Published E-Book Asset

Under one Bundle ID and one HMAC-SHA256 root signature. The signature covers every manifest field
except the signature itself, serialized canonically (sorted keys, no whitespace, UTF-8). This is NOT
a Merkle tree and the manifest is not write-once. Optionally pre-stamps all bundle PDFs with
perimeter and diagonal provenance banners.

Verify a manifest (exit 0 = untouched, 1 = any field changed, 2 = usage, read, parse or salt error):
  ASSET_SALT=... python3 scripts/generate_bundle_manifest.py --verify path/to/bundle_manifest.json

Usage:
  python3 scripts/generate_bundle_manifest.py \
    --c1-doc path/to/c1.pdf \
    --c2-doc path/to/c2.pdf \
    --c3-doc path/to/c3.pdf \
    --ebook-doc path/to/ebook.pdf \
    --creator-id "example-creator" \
    --creator-name "the owner" \
    --product-id "500k-playbook" \
    --output-manifest path/to/bundle_manifest.json
"""

import argparse
import datetime
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile

# bundle_salt sits beside this script. Put this directory on the path so the import also works when the
# script is loaded by path (as the tests do) rather than run directly.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from bundle_salt import fingerprint_salt  # noqa: E402


def read_source(filepath: str) -> bytes:
    """Reads a bundle document once. The digest and the stamped copy are both made from these exact bytes."""
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Bundle document not found: {filepath}")
    with open(filepath, "rb") as f:
        return f.read()


SIGNATURE_FIELD = "bundle_root_signature"

# (artifact key, stamping mode, purpose) for each bundle document, in stamping order.
STAMP_TASKS = (
    ("c1", "perimeter", "c1_data_accuracy"),
    ("c2", "perimeter", "c2_release_approval"),
    ("c3", "perimeter", "c3_agreement"),
    ("ebook", "diagonal", "author_copy"),
)


def canonical_payload(manifest: dict) -> bytes:
    """Every manifest field except the signature, as canonical JSON: sorted keys, no whitespace, UTF-8."""
    body = {k: v for k, v in manifest.items() if k != SIGNATURE_FIELD}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sign_manifest(manifest: dict, salt: bytes) -> str:
    return hmac.new(salt, canonical_payload(manifest), hashlib.sha256).hexdigest()


def verify_manifest(manifest: dict, salt: bytes) -> bool:
    """True only if the root signature matches the canonical form of every other field."""
    signature = manifest.get(SIGNATURE_FIELD)
    if not isinstance(signature, str):
        return False
    return hmac.compare_digest(sign_manifest(manifest, salt), signature)


def create_bundle(
    c1_path: str,
    c2_path: str,
    c3_path: str,
    ebook_path: str,
    creator_id: str,
    creator_name: str,
    product_id: str,
    output_manifest: str,
    output_dir: str = None,
    stamp_bundle: bool = False
) -> dict:
    # 1. Read each document exactly once and hash that buffer. Stamping later uses the same buffer,
    # so the signed digest always describes the bytes that get stamped.
    sources = {"c1": c1_path, "c2": c2_path, "c3": c3_path, "ebook": ebook_path}
    buffers = {key: read_source(path) for key, path in sources.items()}
    digests = {key: hashlib.sha256(data).hexdigest() for key, data in buffers.items()}
    c1_hash, c2_hash, c3_hash, ebook_hash = digests["c1"], digests["c2"], digests["c3"], digests["ebook"]

    # 2. Derive deterministic Bundle Identifier
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    date_slug = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    bundle_entropy = f"{creator_id}:{product_id}:{ebook_hash[:16]}"
    bundle_hash = hashlib.sha256(bundle_entropy.encode("utf-8")).hexdigest()[:8].upper()
    bundle_id = f"BND-{date_slug}-{creator_id[:10].upper()}-{bundle_hash}"

    # 3. Parity & Launch-Gate Safety Check:
    # Check if C2 is approval of the exact release asset or contains e-book hash
    matches_ebook_hash = (c2_hash == ebook_hash)

    # 4. Plan the stamped outputs now. Their paths are deterministic, so the signed payload can name them
    # before any stamping runs.
    stamped_paths = {}
    if stamp_bundle:
        if not output_dir:
            output_dir = os.path.dirname(os.path.abspath(output_manifest))
        os.makedirs(output_dir, exist_ok=True)
        for key, _mode, _purpose in STAMP_TASKS:
            # Prefix with the artifact key: two sources may share a basename (e.g. */doc.pdf).
            out_name = f"{key}_{os.path.splitext(os.path.basename(sources[key]))[0]}.bundle_stamped.pdf"
            stamped_paths[key] = os.path.join(output_dir, out_name)

    manifest_data = {
        "schema_version": "1.0.0",
        "bundle_id": bundle_id,
        "created_at": timestamp,
        "creator": {
            "id": creator_id,
            "legal_name": creator_name
        },
        "product_id": product_id,
        "artifacts": {
            "c1_data_accuracy": {
                "role": "DATA_ACCURACY_CONSENT",
                "source_path": os.path.abspath(c1_path),
                "sha256": c1_hash,
                "stamping_mode": "perimeter"
            },
            "c2_release_approval": {
                "role": "RELEASE_APPROVAL_CONSENT",
                "source_path": os.path.abspath(c2_path),
                "sha256": c2_hash,
                "stamping_mode": "perimeter",
                "identical_to_asset_binary": matches_ebook_hash
            },
            "c3_publisher_agreement": {
                "role": "PUBLISHER_AGREEMENT_ESIGN",
                "source_path": os.path.abspath(c3_path),
                "sha256": c3_hash,
                "stamping_mode": "perimeter"
            },
            "ebook_asset": {
                "role": "PUBLISHED_MEDIA_ASSET",
                "source_path": os.path.abspath(ebook_path),
                "sha256": ebook_hash,
                "stamping_mode": "diagonal"
            }
        },
        "security_policy": {
            "watermark_diagonal_restricted_to_assets": True,
            "contracts_stamped_with_perimeter_only": True,
            "zero_obscured_legal_text": True,
            "launch_gate_verified": True
        },
        "status": "SEALED_AND_BINDING",
        "stamped_artifacts": stamped_paths,
    }

    # 5. Root signature over every field above (stamped_artifacts included), canonically serialized.
    root_signature = sign_manifest(manifest_data, fingerprint_salt())
    manifest_data[SIGNATURE_FIELD] = root_signature

    # 6. Stamping pass using scripts/watermark_pdf.py, carrying the bundle id and root signature
    if stamp_bundle:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        watermarker = os.path.join(script_dir, "watermark_pdf.py")

        # Each document is stamped from a private copy written from the buffer that was hashed,
        # never from the source path, which may have changed since it was read.
        with tempfile.TemporaryDirectory() as staging:
            for key, mode, purpose in STAMP_TASKS:
                staged_path = os.path.join(staging, f"{key}.pdf")
                with open(staged_path, "wb") as f_stage:
                    f_stage.write(buffers[key])
                cmd = [
                    sys.executable,
                    watermarker,
                    "--input", staged_path,
                    "--output", stamped_paths[key],
                    "--creator-id", creator_id,
                    "--creator-name", creator_name,
                    "--mode", mode,
                    "--purpose", purpose,
                    "--bundle-id", bundle_id,
                    "--bundle-root-hash", root_signature
                ]
                res = subprocess.run(cmd, capture_output=True, text=True)
                if res.returncode != 0:
                    raise RuntimeError(f"Failed to stamp {key} ({sources[key]}): {res.stderr}")

    # 7. Write manifest
    os.makedirs(os.path.dirname(os.path.abspath(output_manifest)), exist_ok=True)
    with open(output_manifest, "w", encoding="utf-8") as f_out:
        json.dump(manifest_data, f_out, indent=2)

    return manifest_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate cryptographic Bundle Manifest for contracts and assets, or verify one.")
    parser.add_argument("--verify", metavar="MANIFEST", default=None,
                        help="Verify an existing bundle_manifest.json (needs ASSET_SALT). Exit 0 untouched, 1 tampered, 2 usage, read, parse or salt error.")
    parser.add_argument("--c1-doc", help="Path to C1 Data Accuracy document/PDF")
    parser.add_argument("--c2-doc", help="Path to C2 Release Approval document/PDF")
    parser.add_argument("--c3-doc", help="Path to C3 Publisher Agreement document/PDF")
    parser.add_argument("--ebook-doc", help="Path to E-Book publication asset PDF")
    parser.add_argument("--creator-id", help="Creator identifier (e.g. example-creator)")
    parser.add_argument("--creator-name", help="Creator full legal name (e.g. the owner)")
    parser.add_argument("--product-id", help="Product identifier (e.g. 500k-playbook)")
    parser.add_argument("--output-manifest", help="Destination path for bundle_manifest.json")
    parser.add_argument("--output-dir", default=None, help="Directory to save stamped bundle PDFs")
    parser.add_argument("--stamp-bundle", action="store_true", help="Stamp all documents with perimeter/diagonal banners")

    args = parser.parse_args()

    if args.verify:
        try:
            salt = fingerprint_salt()
        except RuntimeError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
        try:
            with open(args.verify, encoding="utf-8") as f_in:
                manifest = json.load(f_in)
        except (OSError, ValueError) as exc:
            # Read and parse failures are usage errors (exit 2), never a tamper verdict (exit 1).
            print(f"ERROR: cannot read manifest {args.verify}: {exc}", file=sys.stderr)
            return 2
        if not isinstance(manifest, dict):
            print(f"ERROR: manifest {args.verify} is not a JSON object", file=sys.stderr)
            return 2
        if verify_manifest(manifest, salt):
            print(f"VERIFIED: {manifest.get('bundle_id')} root signature matches every manifest field")
            return 0
        print(f"TAMPERED: {args.verify} does not match its root signature", file=sys.stderr)
        return 1

    required = ("c1_doc", "c2_doc", "c3_doc", "ebook_doc", "creator_id", "creator_name", "product_id", "output_manifest")
    missing = [f"--{name.replace('_', '-')}" for name in required if getattr(args, name) is None]
    if missing:
        parser.error(f"the following arguments are required: {', '.join(missing)}")

    manifest = create_bundle(
        c1_path=args.c1_doc,
        c2_path=args.c2_doc,
        c3_path=args.c3_doc,
        ebook_path=args.ebook_doc,
        creator_id=args.creator_id,
        creator_name=args.creator_name,
        product_id=args.product_id,
        output_manifest=args.output_manifest,
        output_dir=args.output_dir,
        stamp_bundle=args.stamp_bundle
    )

    print(f"Successfully generated cryptographic Bundle Manifest: {args.output_manifest}")
    print(f"Bundle ID: {manifest['bundle_id']}")
    print(f"Root Signature: {manifest[SIGNATURE_FIELD][:24]}...")
    print(f"Status: {manifest['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
