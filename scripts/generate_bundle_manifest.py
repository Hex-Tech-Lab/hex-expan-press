#!/usr/bin/env python3
"""
scripts/generate_bundle_manifest.py  -  Unified Cryptographic Bundle Signing Engine

Binds four bundle artifacts:
1. C1 Data Accuracy Consent
2. C2 Release Approval Consent
3. C3 Publisher Agreement (Firma e-signature envelope)
4. The Published E-Book Asset

Under one Bundle ID and one HMAC-SHA256 root signature. The root signature covers every manifest field except the
signature itself and the stamped-artifact fields, serialized canonically (sorted keys, no whitespace, UTF-8). The
stamped-artifact fields hold the SHA-256 of each stamped PDF. A second HMAC, over those digests and the root signature,
signs them. The stamp embeds the root signature, so the digests cannot be part of the root signature itself.
This is NOT a Merkle tree and the manifest is not write-once. Optionally pre-stamps all bundle PDFs:
perimeter banners on the three contracts and a diagonal watermark on the e-book.

Verify a manifest. Exit 0: both signatures match and every referenced file matches its signed digest. Exit 1: tampered,
meaning a manifest field changed, a source file it names is missing or its digest differs, or a stamped file it names is
missing, its bytes differ from the signed digest, or its metadata differs. Exit 2: usage, read, parse or salt error. A file
the manifest names that exists but cannot be read is a read error (exit 2), not a verdict.
Verification reads the source paths recorded at signing, so run it where those files are:
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
from bundle_salt import fingerprint_salt

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


SIGNATURE_FIELD = "bundle_root_signature"
# Added after stamping: the SHA-256 of each stamped file, and a signature over those digests and the root signature.
STAMP_DIGESTS_FIELD = "stamped_artifact_sha256"
STAMP_SIGNATURE_FIELD = "stamped_artifact_signature"
_STAMP_SIGNATURE_LABEL = b"bundle-stamped-artifacts-v1\n"
# Written while the launch gate is not run by this generator. Not a sealed or binding status.
STATUS_PENDING_LAUNCH_GATE = "PENDING_LAUNCH_GATE"

# (artifact key, stamping mode, purpose) for each bundle document, in stamping order.
STAMP_TASKS = (
    ("c1", "perimeter", "c1_data_accuracy"),
    ("c2", "perimeter", "c2_release_approval"),
    ("c3", "perimeter", "c3_agreement"),
    ("ebook", "diagonal", "author_copy"),
)
REQUIRED_STAMP_NAMES = frozenset(k for k, _, _ in STAMP_TASKS)
# Manifest artifact name for each source and stamp key. The keys match STAMP_TASKS.
ARTIFACT_NAMES = {
    "c1": "c1_data_accuracy",
    "c2": "c2_release_approval",
    "c3": "c3_publisher_agreement",
    "ebook": "ebook_asset",
}
# Fields that are added after the root signature is made, so the root signature does not cover them.
_POST_SIGNATURE_FIELDS = (SIGNATURE_FIELD, STAMP_DIGESTS_FIELD, STAMP_SIGNATURE_FIELD)

COPY_CHUNK_BYTES = 1 << 16
# A stuck PDF parser or child must fail the bundle, not block it. This is a fixed bound, not a measured stamp time.
STAMP_TIMEOUT_SECONDS = 300


def _canonical_json(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def canonical_payload(manifest: dict) -> bytes:
    """Every manifest field the root signature covers, as canonical JSON: sorted keys, no whitespace, UTF-8."""
    return _canonical_json({k: v for k, v in manifest.items() if k not in _POST_SIGNATURE_FIELDS})


def sign_manifest(manifest: dict, salt: bytes) -> str:
    return hmac.new(salt, canonical_payload(manifest), hashlib.sha256).hexdigest()


def sign_stamped_digests(root_signature: str, digests: dict, salt: bytes) -> str:
    """Signs the stamped-artifact digests together with the root signature, so no digest can change alone."""
    payload = _STAMP_SIGNATURE_LABEL + root_signature.encode("ascii") + b"\n" + _canonical_json(digests)
    return hmac.new(salt, payload, hashlib.sha256).hexdigest()


def _signature_matches(expected: str, signature) -> bool:
    if not isinstance(signature, str):
        return False
    # Both sides as bytes: compare_digest raises TypeError on a non-ASCII str. A signature that is not ASCII can never match.
    return hmac.compare_digest(expected.encode("ascii"), signature.encode("utf-8", "backslashreplace"))


def _verify_stamped_digests(manifest: dict, salt: bytes) -> bool:
    """True when the stamped-artifact fields are exactly what signing wrote. An unstamped manifest carries none of them.
    A stamped manifest must contain exactly the full set of STAMP_TASKS artifacts; partial sets fail verification."""
    stamped = manifest.get("stamped_artifacts") or {}
    present = STAMP_DIGESTS_FIELD in manifest or STAMP_SIGNATURE_FIELD in manifest
    if not stamped:
        return not present
    if not isinstance(stamped, dict) or set(stamped) != REQUIRED_STAMP_NAMES:
        return False
    digests = manifest.get(STAMP_DIGESTS_FIELD)
    if not isinstance(digests, dict) or set(digests) != REQUIRED_STAMP_NAMES:
        return False
    if not all(isinstance(value, str) for value in digests.values()):
        return False
    expected = sign_stamped_digests(manifest[SIGNATURE_FIELD], digests, salt)
    return _signature_matches(expected, manifest.get(STAMP_SIGNATURE_FIELD))


def verify_manifest(manifest: dict, salt: bytes) -> bool:
    """True only if the root signature matches the canonical form of every signed field, and the stamped-artifact
    digests match their own signature. A manifest with no root signature is never verified."""
    if not isinstance(manifest.get(SIGNATURE_FIELD), str):
        return False
    if not _signature_matches(sign_manifest(manifest, salt), manifest[SIGNATURE_FIELD]):
        return False
    return _verify_stamped_digests(manifest, salt)


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


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(COPY_CHUNK_BYTES), b""):
            h.update(chunk)
    return h.hexdigest()


def _stamp_problems(path: str, name: str, manifest: dict) -> list:
    """Checks a stamped file's metadata against the signed manifest: bundle id, root signature and source digest.
    The bytes are checked against the signed stamped-artifact digest in referenced_file_problems."""
    import pypdf  # imported here: only verification of stamped files needs it

    try:
        meta = pypdf.PdfReader(path).metadata or {}
    except OSError:
        raise  # an unreadable file is a read error (exit 2), not a verdict
    except Exception as exc:  # a file that does not parse as a PDF is a verdict
        return [f"{name}: stamped file is unreadable ({exc})"]
    expected = {
        "/BundleId": manifest.get("bundle_id"),
        "/BundleRootHash": manifest.get(SIGNATURE_FIELD),
        "/SourceSha256": (manifest.get("artifacts") or {}).get(name, {}).get("sha256"),
    }
    return [f"{name}: stamped file {field} does not match the signed manifest"
            for field, want in expected.items() if meta.get(field) != want]


def referenced_file_problems(manifest: dict) -> list:
    """Why the files a signed manifest names no longer match it. An empty list means every source file matches its
    recorded digest and every stamped file matches its signed digest and its metadata.

    A file that exists but cannot be read raises OSError. The caller reports that as a read error, not a verdict."""
    problems = []
    artifacts = manifest.get("artifacts") or {}
    for name in ARTIFACT_NAMES.values():
        entry = artifacts.get(name) or {}
        path, digest = entry.get("source_path"), entry.get("sha256")
        if not isinstance(path, str) or not os.path.isfile(path):
            problems.append(f"{name}: source file is missing ({path})")
        elif _sha256_file(path) != digest:
            problems.append(f"{name}: source file changed since signing ({path})")
    stamped_digests = manifest.get(STAMP_DIGESTS_FIELD) or {}
    for key, path in (manifest.get("stamped_artifacts") or {}).items():
        name = ARTIFACT_NAMES.get(key)
        if name is None:
            problems.append(f"stamped_artifacts: unknown key {key!r}")
        elif not isinstance(path, str) or not os.path.isfile(path):
            problems.append(f"{name}: stamped file is missing ({path})")
        else:
            if _sha256_file(path) != stamped_digests.get(key):
                problems.append(f"{name}: stamped file bytes changed since stamping ({path})")
            problems.extend(_stamp_problems(path, name, manifest))
    return problems


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
    """Refuses an output that is a source document or that another output names. Publishing would overwrite either.

    Called before any output reaches its final path. A refused call leaves every source and every existing file
    untouched. It can leave an empty output directory behind, because directories are created before this check.
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


def require_identifiers(creator_id: str, creator_name: str, product_id: str) -> None:
    """Refuses a blank creator id, creator name or product id. Each one is signed, so a blank value would sign nothing useful."""
    for label, value in (("creator_id", creator_id), ("creator_name", creator_name), ("product_id", product_id)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{label} must not be blank")


def refuse_unshowable_stamp_text(creator_name: str, bundle_id: str) -> None:
    """Refuses a stamp whose text has a character outside Latin-1. The stamp cannot show it, and a '?' would be a wrong name.

    The diagonal stamp draws the upper-case name, and 'ÿ' is Latin-1 while its upper case 'Ÿ' is not, so that form is checked too.
    """
    for text in (creator_name, creator_name.upper(), bundle_id):
        try:
            text.encode("latin-1")
        except UnicodeEncodeError:
            raise ValueError(
                f"stamp text {text!r} has a character outside Latin-1 that the stamp cannot show; "
                "use a name that Latin-1 can represent, or create the bundle without --stamp-bundle"
            ) from None


def _collision(dst: str) -> ValueError:
    return ValueError(f"output already exists, refusing to overwrite: {dst}")


def _publish_new(src: str, dst: str) -> os.stat_result:
    """Gives dst the bytes of src only if dst does not exist. Returns the identity of the file this run created at dst.

    A hard link is created in one step. It fails when dst exists, so an existing file is never replaced, and no reader sees
    a partial file. A filesystem without hard links is refused, not copied into: a copy would expose dst while it is
    still being written.
    """
    # A hard link shares src's inode, so src's identity is dst's. Reading it from dst after the link could pick up
    # a file another writer put at dst in the meantime.
    owned = os.stat(src)
    try:
        os.link(src, dst)
    except FileExistsError:
        raise _collision(dst) from None
    except OSError as exc:
        raise RuntimeError(
            f"cannot publish {dst} atomically ({exc.strerror or exc}); bundle outputs need hard links, "
            "so choose an output directory on a filesystem that supports them"
        ) from None
    return owned


def _unpublish(published: list) -> list:
    """Removes each file this run published, newest first. A path is removed only while it still names the file this
    run published, so a file another writer put there is left alone. Returns the paths that could not be removed."""
    leftovers = []
    for dst, owned in reversed(published):
        try:
            if os.path.samestat(os.stat(dst), owned):
                os.remove(dst)
        except FileNotFoundError:
            pass  # already gone
        except OSError:
            leftovers.append(dst)
    return leftovers


def _remove_quietly(path: str, what: str) -> None:
    """Removes a temporary file this run made. A failure is a warning: it must not turn a finished run into an error."""
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        print(f"WARNING: could not remove {what} {path}: {exc}", file=sys.stderr)


def _check_sources(sources: dict) -> None:
    missing = sorted(set(ARTIFACT_NAMES) - set(sources))
    if missing:
        raise ValueError(f"missing bundle sources: {', '.join(missing)}")


def _bundle_id(creator_id: str, product_id: str, ebook_hash: str) -> str:
    # The date slug changes from day to day, so the identifier is not the same across days.
    date_slug = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    bundle_hash = hashlib.sha256(f"{creator_id}:{product_id}:{ebook_hash[:16]}".encode("utf-8")).hexdigest()[:8].upper()
    return f"BND-{date_slug}-{creator_id[:10].upper()}-{bundle_hash}"


def _manifest_fields(bundle_id: str, timestamp: str, creator_id: str, creator_name: str, product_id: str,
                     sources: dict, digests: dict, stamped_paths: dict) -> dict:
    """Every signed manifest field except the root signature and the stamped-artifact fields."""
    # Byte identity only. This says the C2 file and the e-book file are the same bytes. It is not the launch gate: the
    # gate compares the active C2 document_sha256 with the product's release_sha256 and needs the active C1, C2 and C3
    # consents, none of which this script can read. So the generator never signs a gate result.
    matches_ebook_hash = digests["c2"] == digests["ebook"]
    return {
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
                "source_path": os.path.abspath(sources["c1"]),
                "sha256": digests["c1"],
                "stamping_mode": "perimeter"
            },
            "c2_release_approval": {
                "role": "RELEASE_APPROVAL_CONSENT",
                "source_path": os.path.abspath(sources["c2"]),
                "sha256": digests["c2"],
                "stamping_mode": "perimeter",
                "identical_to_asset_binary": matches_ebook_hash
            },
            "c3_publisher_agreement": {
                "role": "PUBLISHER_AGREEMENT_ESIGN",
                "source_path": os.path.abspath(sources["c3"]),
                "sha256": digests["c3"],
                "stamping_mode": "perimeter"
            },
            "ebook_asset": {
                "role": "PUBLISHED_MEDIA_ASSET",
                "source_path": os.path.abspath(sources["ebook"]),
                "sha256": digests["ebook"],
                "stamping_mode": "diagonal"
            }
        },
        # The two True values are literals written to match STAMP_TASKS. They are not checked against it. The two
        # False values are claims this script does not compute: it never checks page content for obscured legal
        # text, and it never runs the launch gate.
        "security_policy": {
            "watermark_diagonal_restricted_to_assets": True,
            "contracts_stamped_with_perimeter_only": True,
            "zero_obscured_legal_text": False,
            "launch_gate_verified": False
        },
        "status": STATUS_PENDING_LAUNCH_GATE,
        "stamped_artifacts": stamped_paths,
    }


def _run_stamper(watermarker: str, params_path: str, key: str, source: str):
    """Runs the stamper on a private settings file. The argv is this interpreter, the watermark script and the params path,
    so no caller-supplied string reaches it. shell=False, and a timeout bounds a stuck child."""
    cmd = [sys.executable, watermarker, "--params", params_path]
    try:
        # Proof, not a shell: cmd is [sys.executable, <this module's watermark_pdf.py>, "--params", <params_path from
        # tempfile.mkstemp>]. Every element is fixed by this module or the interpreter. No caller-supplied string reaches
        # argv; the settings go through the private params file.
        # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit.dangerous-subprocess-use-audit
        return subprocess.run(cmd, capture_output=True, text=True, shell=False, timeout=STAMP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Failed to stamp {key} ({source}): timed out after {STAMP_TIMEOUT_SECONDS}s") from None


def _stamp_all(sources: dict, staged: dict, stage_dir: str, creator_id: str, creator_name: str,
               bundle_id: str, root_signature: str) -> dict:
    """Stamps every staged source into stage_dir. Returns the stamped path for each key. A failed stamp raises."""
    watermarker = os.path.join(_SCRIPT_DIR, "watermark_pdf.py")
    stamped = {}
    for key, mode, purpose in STAMP_TASKS:
        stamp_out = os.path.join(stage_dir, f"{key}.stamped.pdf")
        # The stamp settings travel in a private JSON file, not argv, so a creator name that starts with '-' or holds
        # shell syntax is data.
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
            res = _run_stamper(watermarker, params_path, key, sources[key])
        finally:
            _remove_quietly(params_path, "stamp settings file")
        if res.returncode != 0:
            raise RuntimeError(f"Failed to stamp {key} ({sources[key]}): {res.stderr}")
        stamped[key] = stamp_out
    return stamped


def create_bundle(
    sources: dict,
    creator_id: str,
    creator_name: str,
    product_id: str,
    output_manifest: str,
    output_dir: str = None,
    stamp_bundle: bool = False
) -> dict:
    """Signs the four sources (keys c1, c2, c3, ebook) and, with stamp_bundle, stamps them. Every output reaches its final
    path only after the whole bundle has succeeded. A failed run publishes nothing."""
    # Refused before any file is read or any signature is made.
    _check_sources(sources)
    require_identifiers(creator_id, creator_name, product_id)
    salt = fingerprint_salt()
    stage_dir = None
    manifest_tmp = None
    published = []  # (final path, its stat) for each output this run has published, in publish order
    try:
        stamp_dir = None
        staged = {}
        if stamp_bundle:
            stamp_dir = os.path.abspath(output_dir or os.path.dirname(os.path.abspath(output_manifest)))
            os.makedirs(stamp_dir, exist_ok=True)
            # Staging sits beside the final outputs, so publishing them is a hard link on the same filesystem.
            stage_dir = tempfile.mkdtemp(prefix=".bundle_stage_", dir=stamp_dir)
            staged = {key: os.path.join(stage_dir, f"{key}.pdf") for key in sources}

        # 1. Stream each source once. The digest is taken from the same bytes that are staged for stamping, so the
        # signed digest always describes the bytes that get stamped. No source is held in memory whole.
        digests = {key: _hash_and_copy(path, staged.get(key)) for key, path in sources.items()}
        bundle_id = _bundle_id(creator_id, product_id, digests["ebook"])
        if stamp_bundle:
            refuse_unshowable_stamp_text(creator_name, bundle_id)

        # 2. Plan the stamped outputs. Their paths are deterministic and absolute, so the signed payload can name them
        # and a consumer finds them whatever its working directory.
        stamped_paths = {}
        if stamp_bundle:
            for key, _mode, _purpose in STAMP_TASKS:
                # Prefix with the artifact key: two sources may share a basename (e.g. */doc.pdf).
                out_name = f"{key}_{os.path.splitext(os.path.basename(sources[key]))[0]}.bundle_stamped.pdf"
                stamped_paths[key] = os.path.join(stamp_dir, out_name)

        # Refused before anything reaches a final path: publishing would overwrite a source or a sibling output.
        check_output_paths(sources, {"manifest": output_manifest, **stamped_paths})
        # A second run into the same directory would silently replace the first bundle's stamped PDFs and leave
        # its manifest pointing at bytes that no longer match. Refuse instead; the caller picks a fresh directory.
        # This check runs before stamping, so a file created later at one of these paths is refused at publish time.
        existing = [p for p in [output_manifest, *stamped_paths.values()] if os.path.exists(p)]
        if existing:
            raise _collision(existing[0])

        # 3. Root signature over every signed field, canonically serialized. The stamp embeds this signature.
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        manifest_data = _manifest_fields(bundle_id, timestamp, creator_id, creator_name, product_id,
                                         sources, digests, stamped_paths)
        manifest_data[SIGNATURE_FIELD] = sign_manifest(manifest_data, salt)

        # 4. Stamp every staged source. Each stamp writes into the staging directory; nothing reaches a final path until
        # all four have succeeded.
        stamped_staging = {}
        if stamp_bundle:
            stamped_staging = _stamp_all(sources, staged, stage_dir, creator_id, creator_name, bundle_id,
                                         manifest_data[SIGNATURE_FIELD])
            # The stamped files' digests, signed together with the root signature. This is what binds their page bytes.
            stamped_digests = {key: _sha256_file(path) for key, path in stamped_staging.items()}
            manifest_data[STAMP_DIGESTS_FIELD] = stamped_digests
            manifest_data[STAMP_SIGNATURE_FIELD] = sign_stamped_digests(
                manifest_data[SIGNATURE_FIELD], stamped_digests, salt)

        # 5. Write the manifest to a temporary file beside its target. It is published last, once every stamp has
        # succeeded, so a failed run never leaves a manifest that points at outputs it did not produce.
        manifest_dir = os.path.dirname(os.path.abspath(output_manifest))
        os.makedirs(manifest_dir, exist_ok=True)
        fd, manifest_tmp = tempfile.mkstemp(prefix=".manifest_", suffix=".tmp", dir=manifest_dir)
        with os.fdopen(fd, "w", encoding="utf-8") as f_out:
            json.dump(manifest_data, f_out, indent=2)

        # 6. Publish the stamped outputs, then the manifest.
        for key, stamp_out in stamped_staging.items():
            published.append((stamped_paths[key], _publish_new(stamp_out, stamped_paths[key])))
        published.append((output_manifest, _publish_new(manifest_tmp, output_manifest)))
    except BaseException:
        # A file that appeared at an output path during stamping fails the run here. Remove what this run published
        # so no partial bundle remains. Files this run did not create are never touched.
        for leftover in _unpublish(published):
            print(f"WARNING: could not remove {leftover}; this run published it and it remains", file=sys.stderr)
        raise
    finally:
        if stage_dir:
            shutil.rmtree(stage_dir, ignore_errors=True)
        if manifest_tmp:
            _remove_quietly(manifest_tmp, "temporary manifest")

    return manifest_data


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate cryptographic Bundle Manifest for contracts and assets, or verify one.")
    parser.add_argument("--verify", metavar="MANIFEST", default=None,
                        help="Verify an existing bundle_manifest.json (needs ASSET_SALT). Exit 0 verified, 1 tampered (a field, a referenced source file, or a stamped file's bytes or metadata changed or is missing), 2 usage, read, parse or salt error.")
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
            try:
                problems = referenced_file_problems(manifest)
            except OSError as exc:
                # A file the manifest names exists but cannot be read: a read error, not a verdict.
                print(f"ERROR: cannot read a file the manifest names: {exc}", file=sys.stderr)
                return 2
            if problems:
                print(f"TAMPERED: {args.verify} has a valid signature, but a referenced file does not match:", file=sys.stderr)
                for problem in problems:
                    print(f"  - {problem}", file=sys.stderr)
                return 1
            print(f"VERIFIED: {manifest.get('bundle_id')} signatures match every manifest field and every referenced file")
            return 0
        print(f"TAMPERED: {args.verify} does not match its root signature or its stamped-artifact signature", file=sys.stderr)
        return 1

    required = ("c1_doc", "c2_doc", "c3_doc", "ebook_doc", "creator_id", "creator_name", "product_id", "output_manifest")
    missing = [f"--{name.replace('_', '-')}" for name in required if getattr(args, name) is None]
    if missing:
        parser.error(f"the following arguments are required: {', '.join(missing)}")

    try:
        manifest = create_bundle(
            sources={"c1": args.c1_doc, "c2": args.c2_doc, "c3": args.c3_doc, "ebook": args.ebook_doc},
            creator_id=args.creator_id,
            creator_name=args.creator_name,
            product_id=args.product_id,
            output_manifest=args.output_manifest,
            output_dir=args.output_dir,
            stamp_bundle=args.stamp_bundle
        )
    except (ValueError, RuntimeError, OSError) as exc:
        # A refused identifier, stamp text, output path, salt, failed stamp, unreadable source or unavailable hard link is
        # an error and no bundle is published. A rollback that cannot remove one prints a WARNING.
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(f"Successfully generated cryptographic Bundle Manifest: {args.output_manifest}")
    print(f"Bundle ID: {manifest['bundle_id']}")
    print(f"Root Signature: {manifest[SIGNATURE_FIELD][:24]}...")
    print(f"Status: {manifest['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
