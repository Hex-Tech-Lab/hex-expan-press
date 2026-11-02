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

Verify a manifest (exit 0 = untouched, 1 = tampered: a field changed, or a source or stamped file it names is
missing or no longer matches, 2 = usage, read, parse or salt error). Verification reads the source paths
recorded at signing, so run it where those files are:
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
import contextlib
import datetime
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile

# bundle_salt sits beside this script. Put this directory on the path so the import also works when the
# script is loaded by path (as the tests do) rather than run directly.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from bundle_salt import fingerprint_salt  # noqa: E402


SIGNATURE_FIELD = "bundle_root_signature"
# Written while the launch gate is not run by this generator. Not a sealed or binding status.
STATUS_PENDING_LAUNCH_GATE = "PENDING_LAUNCH_GATE"

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
    # Both sides as bytes: compare_digest raises TypeError on a non-ASCII str. A signature that is not ASCII can never match.
    return hmac.compare_digest(
        sign_manifest(manifest, salt).encode("ascii"),
        signature.encode("utf-8", "backslashreplace"),
    )


def _reject_duplicate_keys(pairs: list) -> dict:
    """json object hook: a repeated key is an error. Python's default keeps the last value, which a first-value reader would not."""
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"duplicate key {key!r}")
        obj[key] = value
    return obj


def _reject_constant(name: str):
    """json parse_constant hook: NaN, Infinity and -Infinity are not JSON."""
    raise ValueError(f"non-standard JSON constant {name}")


def load_manifest(path: str) -> dict:
    """Parses a manifest strictly. Raises OSError, ValueError or RecursionError on any read or parse failure."""
    with open(path, encoding="utf-8") as f_in:
        text = f_in.read()
    return json.loads(text, object_pairs_hook=_reject_duplicate_keys, parse_constant=_reject_constant)


# Manifest artifact name for each source and stamp key. The keys match STAMP_TASKS.
ARTIFACT_NAMES = {
    "c1": "c1_data_accuracy",
    "c2": "c2_release_approval",
    "c3": "c3_publisher_agreement",
    "ebook": "ebook_asset",
}


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _stamp_problems(path: str, name: str, manifest: dict) -> list:
    """A stamped file is bound to the signed manifest by its own metadata: bundle id, root signature, source digest."""
    import pypdf  # imported here: only verification of stamped files needs it

    try:
        meta = pypdf.PdfReader(path).metadata or {}
    except Exception as exc:  # any read failure of a file named by the manifest is a verdict, not a crash
        return [f"{name}: stamped file is unreadable ({exc})"]
    expected = {
        "/BundleId": manifest.get("bundle_id"),
        "/BundleRootHash": manifest.get(SIGNATURE_FIELD),
        "/SourceSha256": (manifest.get("artifacts") or {}).get(name, {}).get("sha256"),
    }
    return [f"{name}: stamped file {field} does not match the signed manifest"
            for field, want in expected.items() if meta.get(field) != want]


def referenced_file_problems(manifest: dict) -> list:
    """Why the files a signed manifest names no longer match it. An empty list means every one still matches."""
    problems = []
    artifacts = manifest.get("artifacts") or {}
    for name in ARTIFACT_NAMES.values():
        entry = artifacts.get(name) or {}
        path, digest = entry.get("source_path"), entry.get("sha256")
        if not isinstance(path, str) or not os.path.isfile(path):
            problems.append(f"{name}: source file is missing ({path})")
        elif _sha256_file(path) != digest:
            problems.append(f"{name}: source file changed since signing ({path})")
    for key, path in (manifest.get("stamped_artifacts") or {}).items():
        name = ARTIFACT_NAMES.get(key)
        if name is None:
            problems.append(f"stamped_artifacts: unknown key {key!r}")
        elif not isinstance(path, str) or not os.path.isfile(path):
            problems.append(f"{name}: stamped file is missing ({path})")
        else:
            problems.extend(_stamp_problems(path, name, manifest))
    return problems


COPY_CHUNK_BYTES = 1 << 16
# A stuck PDF parser or child must fail the bundle, not block it. Generous: a stamp is a few hundred ms.
STAMP_TIMEOUT_SECONDS = 300


def _hash_and_copy(src: str, dst: str | None) -> str:
    """Streams one source once: hashes it and, when dst is given, writes the same bytes there. Memory use is one chunk."""
    if not os.path.exists(src):
        raise FileNotFoundError(f"Bundle document not found: {src}")
    h = hashlib.sha256()
    with open(src, "rb") as f_in, (open(dst, "wb") if dst else contextlib.nullcontext()) as f_out:
        for chunk in iter(lambda: f_in.read(COPY_CHUNK_BYTES), b""):
            h.update(chunk)
            if f_out is not None:
                f_out.write(chunk)
    return h.hexdigest()


def _same_path(a: str, b: str) -> bool:
    """True when two paths name one file: the same real path, or hard links to one existing file."""
    if os.path.realpath(a) == os.path.realpath(b):
        return True
    return os.path.exists(a) and os.path.exists(b) and os.path.samefile(a, b)


def check_output_paths(sources: dict, outputs: dict) -> None:
    """Refuses an output that is a source document or that another output names. os.replace would overwrite either.

    Called before any output is written, so a refused call leaves every source and every existing file untouched.
    """
    seen = {}
    for name, dest in outputs.items():
        for key, src in sources.items():
            if _same_path(dest, src):
                raise ValueError(f"{name} output {dest} is the source document {key} ({src}); choose another path")
        for other, other_dest in seen.items():
            if _same_path(dest, other_dest):
                raise ValueError(f"{name} and {other} outputs both name {dest}; choose distinct paths")
        seen[name] = dest


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
    sources = {"c1": c1_path, "c2": c2_path, "c3": c3_path, "ebook": ebook_path}
    stage_dir = None
    manifest_tmp = None
    try:
        staged = {}
        stamp_dir = None
        if stamp_bundle:
            if not output_dir:
                output_dir = os.path.dirname(os.path.abspath(output_manifest))
            stamp_dir = os.path.abspath(output_dir)
            os.makedirs(stamp_dir, exist_ok=True)
            # Staging sits beside the final outputs, so publishing them is a rename on the same filesystem.
            stage_dir = tempfile.mkdtemp(prefix=".bundle_stage_", dir=stamp_dir)
            staged = {key: os.path.join(stage_dir, f"{key}.pdf") for key in sources}

        # 1. Stream each source once. The digest is taken from the same bytes that are staged for stamping, so the
        # signed digest always describes the bytes that get stamped. No source is held in memory whole.
        digests = {key: _hash_and_copy(path, staged.get(key)) for key, path in sources.items()}
        c1_hash, c2_hash, c3_hash, ebook_hash = digests["c1"], digests["c2"], digests["c3"], digests["ebook"]

        # 2. Derive deterministic Bundle Identifier
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        date_slug = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
        bundle_entropy = f"{creator_id}:{product_id}:{ebook_hash[:16]}"
        bundle_hash = hashlib.sha256(bundle_entropy.encode("utf-8")).hexdigest()[:8].upper()
        bundle_id = f"BND-{date_slug}-{creator_id[:10].upper()}-{bundle_hash}"

        # 3. Byte identity only. This says the C2 file and the e-book file are the same bytes. It is not the launch
        # gate: the gate compares the active C2 document_sha256 with the product's release_sha256 and needs the active
        # C1, C2 and C3 consents, none of which this script can read. So the generator never signs a gate result.
        matches_ebook_hash = (c2_hash == ebook_hash)

        # 4. Plan the stamped outputs now. Their paths are deterministic and absolute, so the signed payload can
        # name them and a consumer finds them whatever its working directory.
        stamped_paths = {}
        if stamp_bundle:
            for key, _mode, _purpose in STAMP_TASKS:
                # Prefix with the artifact key: two sources may share a basename (e.g. */doc.pdf).
                out_name = f"{key}_{os.path.splitext(os.path.basename(sources[key]))[0]}.bundle_stamped.pdf"
                stamped_paths[key] = os.path.join(stamp_dir, out_name)

        # Refused before anything reaches a final path: os.replace below would overwrite a source or a sibling output.
        check_output_paths(sources, {"manifest": output_manifest, **stamped_paths})
        # A second run into the same directory would silently replace the first bundle's stamped PDFs and leave
        # its manifest pointing at bytes that no longer match. Refuse instead; the caller picks a fresh directory.
        existing = [p for p in [output_manifest, *stamped_paths.values()] if os.path.exists(p)]
        if existing:
            raise ValueError(f"output already exists, refusing to overwrite: {existing[0]}")

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
            # The two True values are fixed by STAMP_TASKS. The two False values are claims this script does not
            # compute: it never checks page content for obscured legal text, and it never runs the launch gate.
            "security_policy": {
                "watermark_diagonal_restricted_to_assets": True,
                "contracts_stamped_with_perimeter_only": True,
                "zero_obscured_legal_text": False,
                "launch_gate_verified": False
            },
            "status": STATUS_PENDING_LAUNCH_GATE,
            "stamped_artifacts": stamped_paths,
        }

        # 5. Root signature over every field above (stamped_artifacts included), canonically serialized.
        root_signature = sign_manifest(manifest_data, fingerprint_salt())
        manifest_data[SIGNATURE_FIELD] = root_signature

        # 6. Write the manifest to a temporary file beside its target. It is renamed into place last, once every stamp
        # has succeeded, so a failed run never leaves a manifest that points at outputs it did not produce.
        manifest_dir = os.path.dirname(os.path.abspath(output_manifest))
        os.makedirs(manifest_dir, exist_ok=True)
        fd, manifest_tmp = tempfile.mkstemp(prefix=".manifest_", suffix=".tmp", dir=manifest_dir)
        with os.fdopen(fd, "w", encoding="utf-8") as f_out:
            json.dump(manifest_data, f_out, indent=2)

        # 7. Stamping pass using scripts/watermark_pdf.py, carrying the bundle id and root signature. Each stamp writes
        # into the staging directory; nothing reaches a final path until all four have succeeded.
        if stamp_bundle:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            watermarker = os.path.join(script_dir, "watermark_pdf.py")
            stamped_staging = {}
            for key, mode, purpose in STAMP_TASKS:
                stamp_out = os.path.join(stage_dir, f"{key}.stamped.pdf")
                # The stamp settings travel in a private JSON file, not argv. The argument vector is then the interpreter,
                # this module's watermark script, and a temp-file path made here, so no caller-supplied string reaches
                # argv. shell=False, and a creator name that starts with '-' or holds shell syntax is data.
                settings = {
                    "input": staged[key],
                    "output": stamp_out,
                    "creator_id": creator_id,
                    "creator_name": creator_name,
                    "mode": mode,
                    "purpose": purpose,
                    "bundle_id": bundle_id,
                    "bundle_root_hash": root_signature,
                }
                fd, params_path = tempfile.mkstemp(prefix="bundle_stamp_", suffix=".json")
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as f_params:
                        json.dump(settings, f_params)
                    cmd = [sys.executable, watermarker, "--params", params_path]
                    try:
                        # Proof, not a shell: cmd is [sys.executable, <this module's watermark_pdf.py>, "--params",
                        # <params_path from tempfile.mkstemp>]. Every element is fixed by this module or the interpreter.
                        # No caller-supplied string reaches argv; the settings go through the private params file.
                        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit
                        res = subprocess.run(cmd, capture_output=True, text=True, shell=False, timeout=STAMP_TIMEOUT_SECONDS)
                    except subprocess.TimeoutExpired:
                        raise RuntimeError(f"Failed to stamp {key} ({sources[key]}): timed out after {STAMP_TIMEOUT_SECONDS}s")
                finally:
                    os.remove(params_path)
                if res.returncode != 0:
                    raise RuntimeError(f"Failed to stamp {key} ({sources[key]}): {res.stderr}")
                stamped_staging[key] = stamp_out
            for key, stamp_out in stamped_staging.items():
                os.replace(stamp_out, stamped_paths[key])

        os.replace(manifest_tmp, output_manifest)
        manifest_tmp = None
    finally:
        if stage_dir:
            shutil.rmtree(stage_dir, ignore_errors=True)
        if manifest_tmp and os.path.exists(manifest_tmp):
            os.remove(manifest_tmp)

    return manifest_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate cryptographic Bundle Manifest for contracts and assets, or verify one.")
    parser.add_argument("--verify", metavar="MANIFEST", default=None,
                        help="Verify an existing bundle_manifest.json (needs ASSET_SALT). Exit 0 untouched, 1 tampered (a field, or a referenced source or stamped file, changed or is missing), 2 usage, read, parse or salt error.")
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
            manifest = load_manifest(args.verify)
        except (OSError, ValueError, RecursionError) as exc:
            # Read and parse failures are usage errors (exit 2), never a tamper verdict (exit 1).
            print(f"ERROR: cannot read manifest {args.verify}: {exc}", file=sys.stderr)
            return 2
        if not isinstance(manifest, dict):
            print(f"ERROR: manifest {args.verify} is not a JSON object", file=sys.stderr)
            return 2
        try:
            signed_ok = verify_manifest(manifest, salt)
        except (RecursionError, UnicodeEncodeError) as exc:
            # The signed form cannot be serialized (too deep, or a lone surrogate): the document is malformed, so exit 2.
            print(f"ERROR: manifest {args.verify} cannot be canonicalized: {type(exc).__name__}", file=sys.stderr)
            return 2
        if signed_ok:
            problems = referenced_file_problems(manifest)
            if problems:
                print(f"TAMPERED: {args.verify} has a valid root signature, but a referenced file does not match:", file=sys.stderr)
                for problem in problems:
                    print(f"  - {problem}", file=sys.stderr)
                return 1
            print(f"VERIFIED: {manifest.get('bundle_id')} root signature matches every manifest field and every referenced file")
            return 0
        print(f"TAMPERED: {args.verify} does not match its root signature", file=sys.stderr)
        return 1

    required = ("c1_doc", "c2_doc", "c3_doc", "ebook_doc", "creator_id", "creator_name", "product_id", "output_manifest")
    missing = [f"--{name.replace('_', '-')}" for name in required if getattr(args, name) is None]
    if missing:
        parser.error(f"the following arguments are required: {', '.join(missing)}")

    try:
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
    except ValueError as exc:
        # A colliding output path is a usage error. Nothing was written.
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"Successfully generated cryptographic Bundle Manifest: {args.output_manifest}")
    print(f"Bundle ID: {manifest['bundle_id']}")
    print(f"Root Signature: {manifest[SIGNATURE_FIELD][:24]}...")
    print(f"Status: {manifest['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
