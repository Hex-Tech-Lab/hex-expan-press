#!/usr/bin/env python3
"""
scripts/__tests__/test_bundle_manifest.py

Automated integration test for the Unified Cryptographic Bundle Engine & Dual-Mode Watermarking.
Tests:
1. Perimeter watermarking mode for legal contracts (C1, C2, C3).
2. Diagonal watermarking mode for digital media assets (E-Book).
3. Bundle manifest generation with deterministic root Merkle/HMAC signature.
4. Tamper detection: verifying that altering any file breaks the bundle signature.
"""

import copy
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
import pypdf

TEST_SALT = "test-only-salt-that-is-at-least-32-chars"  # 40 characters; the scripts refuse anything shorter
os.environ.setdefault("ASSET_SALT", TEST_SALT)

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
WATERMARK_SCRIPT = os.path.join(REPO_ROOT, "scripts/watermark_pdf.py")
MANIFEST_SCRIPT = os.path.join(REPO_ROOT, "scripts/generate_bundle_manifest.py")


def create_dummy_pdf(filepath: str, text: str = "Test Legal Clause Content"):
    """Creates a minimal valid 1-page PDF for test fixtures."""
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=612, height=792)  # Standard Letter
    writer.add_metadata({"/CustomContent": text})
    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    with open(filepath, "wb") as f:
        writer.write(f)


class TestBundleManifest(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="bundle_test_")
        self.c1_pdf = os.path.join(self.test_dir, "c1_data_accuracy.pdf")
        self.c2_pdf = os.path.join(self.test_dir, "c2_release_approval.pdf")
        self.c3_pdf = os.path.join(self.test_dir, "c3_publisher_agreement.pdf")
        self.ebook_pdf = os.path.join(self.test_dir, "ebook_asset.pdf")

        create_dummy_pdf(self.c1_pdf, "C1: Source data validated by creator.")
        create_dummy_pdf(self.c2_pdf, "C2: Release approved for public sale.")
        create_dummy_pdf(self.c3_pdf, "C3: Revenue split publisher agreement.")
        create_dummy_pdf(self.ebook_pdf, "E-Book: 500k Retirement Playbook Chapter 1.")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_perimeter_watermarking_for_contracts(self):
        """Verify that perimeter mode creates a valid PDF with audit headers and proper metadata."""
        out_pdf = os.path.join(self.test_dir, "c1_stamped.pdf")
        cmd = [
            sys.executable,
            WATERMARK_SCRIPT,
            "--input", self.c1_pdf,
            "--output", out_pdf,
            "--creator-id", "test_creator_123",
            "--creator-name", "Jane Doe",
            "--mode", "perimeter",
            "--purpose", "c1_data_accuracy",
            "--bundle-id", "BND-TEST-001"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, f"Watermark perimeter failed: {res.stderr}")

        # Check PDF readability and metadata
        reader = pypdf.PdfReader(out_pdf)
        self.assertEqual(len(reader.pages), 1)
        meta = reader.metadata
        self.assertEqual(meta.get("/BundleId"), "BND-TEST-001")
        self.assertEqual(meta.get("/DocumentMode"), "perimeter")
        self.assertEqual(meta.get("/ProvenancePurpose"), "c1_data_accuracy")
        self.assertTrue(meta.get("/ProvenanceFingerprint") is not None)

    def test_diagonal_watermarking_for_ebook(self):
        """Verify that diagonal mode creates a valid PDF with diagonal watermark and proper metadata."""
        out_pdf = os.path.join(self.test_dir, "ebook_stamped.pdf")
        cmd = [
            sys.executable,
            WATERMARK_SCRIPT,
            "--input", self.ebook_pdf,
            "--output", out_pdf,
            "--creator-id", "test_creator_123",
            "--creator-name", "Jane Doe",
            "--mode", "diagonal",
            "--purpose", "review",
            "--bundle-id", "BND-TEST-001"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, f"Watermark diagonal failed: {res.stderr}")

        reader = pypdf.PdfReader(out_pdf)
        self.assertEqual(len(reader.pages), 1)
        meta = reader.metadata
        self.assertEqual(meta.get("/BundleId"), "BND-TEST-001")
        self.assertEqual(meta.get("/DocumentMode"), "diagonal")

    def test_bundle_manifest_generation_and_stamping(self):
        """Verify complete bundle generation linking all 4 documents under one root signature."""
        manifest_path = os.path.join(self.test_dir, "bundle_manifest.json")
        stamped_dir = os.path.join(self.test_dir, "stamped_output")

        cmd = [
            sys.executable,
            MANIFEST_SCRIPT,
            "--c1-doc", self.c1_pdf,
            "--c2-doc", self.c2_pdf,
            "--c3-doc", self.c3_pdf,
            "--ebook-doc", self.ebook_pdf,
            "--creator-id", "example-creator",
            "--creator-name", "the owner",
            "--product-id", "500k-playbook",
            "--output-manifest", manifest_path,
            "--output-dir", stamped_dir,
            "--stamp-bundle"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, f"Manifest generation failed: {res.stderr}")

        self.assertTrue(os.path.exists(manifest_path))
        with open(manifest_path, "r") as f:
            manifest = json.load(f)

        # Check required fields
        self.assertIn("bundle_id", manifest)
        self.assertIn("bundle_root_signature", manifest)
        self.assertEqual(manifest["creator"]["id"], "example-creator")
        self.assertEqual(manifest["creator"]["legal_name"], "the owner")
        self.assertEqual(manifest["status"], "SEALED_AND_BINDING")

        # Verify all 4 artifacts are registered
        artifacts = manifest["artifacts"]
        self.assertIn("c1_data_accuracy", artifacts)
        self.assertIn("c2_release_approval", artifacts)
        self.assertIn("c3_publisher_agreement", artifacts)
        self.assertIn("ebook_asset", artifacts)

        # Verify stamped files were created
        stamped = manifest.get("stamped_artifacts", {})
        self.assertEqual(len(stamped), 4)
        for key, p in stamped.items():
            self.assertTrue(os.path.exists(p), f"Stamped file missing: {p}")
            reader = pypdf.PdfReader(p)
            self.assertEqual(reader.metadata.get("/BundleId"), manifest["bundle_id"])
            self.assertEqual(reader.metadata.get("/BundleRootHash"), manifest["bundle_root_signature"])

    def test_tamper_detection(self):
        """Verify that tampering with any document in the bundle produces a completely different root signature."""
        manifest1_path = os.path.join(self.test_dir, "manifest1.json")
        cmd1 = [
            sys.executable,
            MANIFEST_SCRIPT,
            "--c1-doc", self.c1_pdf,
            "--c2-doc", self.c2_pdf,
            "--c3-doc", self.c3_pdf,
            "--ebook-doc", self.ebook_pdf,
            "--creator-id", "example-creator",
            "--creator-name", "the owner",
            "--product-id", "500k-playbook",
            "--output-manifest", manifest1_path
        ]
        subprocess.run(cmd1, check=True)
        with open(manifest1_path) as f:
            sig1 = json.load(f)["bundle_root_signature"]

        # Tamper with the E-Book asset
        tampered_ebook = os.path.join(self.test_dir, "ebook_tampered.pdf")
        create_dummy_pdf(tampered_ebook, "TAMPERED: Altered royalties clause or contents!")

        manifest2_path = os.path.join(self.test_dir, "manifest2.json")
        cmd2 = [
            sys.executable,
            MANIFEST_SCRIPT,
            "--c1-doc", self.c1_pdf,
            "--c2-doc", self.c2_pdf,
            "--c3-doc", self.c3_pdf,
            "--ebook-doc", tampered_ebook,
            "--creator-id", "example-creator",
            "--creator-name", "the owner",
            "--product-id", "500k-playbook",
            "--output-manifest", manifest2_path
        ]
        subprocess.run(cmd2, check=True)
        with open(manifest2_path) as f:
            sig2 = json.load(f)["bundle_root_signature"]

        self.assertNotEqual(sig1, sig2, "Tampered artifact failed to alter root bundle signature!")

    def _signature_for(self, c1, c2, c3, ebook, name):
        out = os.path.join(self.test_dir, f"{name}.json")
        subprocess.run([
            sys.executable, MANIFEST_SCRIPT, "--c1-doc", c1, "--c2-doc", c2, "--c3-doc", c3,
            "--ebook-doc", ebook, "--creator-id", "example-creator", "--creator-name", "the owner",
            "--product-id", "500k-playbook", "--output-manifest", out], check=True, capture_output=True)
        with open(out) as f:
            return json.load(f)["bundle_root_signature"]

    def test_each_contract_change_alters_signature(self):
        baseline = self._signature_for(self.c1_pdf, self.c2_pdf, self.c3_pdf, self.ebook_pdf, "base")
        for label, idx in (("c1", 0), ("c2", 1), ("c3", 2)):
            docs = [self.c1_pdf, self.c2_pdf, self.c3_pdf]
            altered = os.path.join(self.test_dir, f"{label}_altered.pdf")
            create_dummy_pdf(altered, f"{label} altered clause")
            docs[idx] = altered
            sig = self._signature_for(*docs, self.ebook_pdf, f"alt_{label}")
            self.assertNotEqual(sig, baseline, f"altering {label} did not change the root signature")



class TestAssetSaltFailsClosed(unittest.TestCase):
    """Both scripts must refuse to sign when ASSET_SALT is unset, instead of using a built-in default."""

    def _run_without_salt(self, script, extra_args):
        env = {k: v for k, v in os.environ.items() if k != "ASSET_SALT"}
        return subprocess.run(
            [sys.executable, script, *extra_args],
            capture_output=True,
            text=True,
            env=env,
        )

    def test_watermark_refuses_without_salt_and_manifest_help_needs_none(self):
        res = self._run_without_salt(MANIFEST_SCRIPT, ["--help"])
        self.assertEqual(res.returncode, 0, "--help must not need the salt")
        with tempfile.TemporaryDirectory() as tmp:
            dummy = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(dummy)
            res = self._run_without_salt(WATERMARK_SCRIPT, ["--input", dummy, "--output", os.path.join(tmp, "o.pdf"), "--mode", "perimeter", "--creator-id", "c", "--creator-name", "n", "--purpose", "review"])
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("ASSET_SALT is not set", res.stderr)

    def test_manifest_itself_refuses_to_sign_without_salt(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = {}
            for name in ("c1", "c2", "c3", "ebook"):
                docs[name] = os.path.join(tmp, f"{name}.pdf")
                create_dummy_pdf(docs[name], name)
            manifest = os.path.join(tmp, "m.json")
            res = self._run_without_salt(MANIFEST_SCRIPT, [
                "--c1-doc", docs["c1"], "--c2-doc", docs["c2"], "--c3-doc", docs["c3"],
                "--ebook-doc", docs["ebook"], "--creator-id", "c", "--creator-name", "n",
                "--product-id", "p", "--output-manifest", manifest,
            ])
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("ASSET_SALT is not set", res.stderr)
            self.assertFalse(os.path.exists(manifest), "no manifest may be written unsigned")

    def test_whitespace_only_salt_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(src)
            env = dict(os.environ, ASSET_SALT="   ")
            res = subprocess.run(
                [sys.executable, WATERMARK_SCRIPT, "--input", src, "--output", os.path.join(tmp, "o.pdf"),
                 "--creator-id", "c", "--creator-name", "n", "--mode", "perimeter", "--purpose", "review"],
                capture_output=True, text=True, env=env)
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("ASSET_SALT is not set", res.stderr)

    def test_forty_space_salt_is_refused_only_by_the_blank_rule(self):
        """P2: 40 spaces clear the 32-character length rule, so only the strip (blank) rule refuses them."""
        blank = " " * 40
        self.assertGreaterEqual(len(blank), 32)  # the length rule alone would accept this salt
        with tempfile.TemporaryDirectory() as tmp:
            docs = {}
            for name in ("c1", "c2", "c3", "ebook"):
                docs[name] = os.path.join(tmp, f"{name}.pdf")
                create_dummy_pdf(docs[name], name)
            out = os.path.join(tmp, "o.pdf")
            res = subprocess.run(
                [sys.executable, WATERMARK_SCRIPT, "--input", docs["c1"], "--output", out,
                 "--creator-id", "c", "--creator-name", "n", "--mode", "perimeter", "--purpose", "review"],
                capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=blank))
            self.assertNotEqual(res.returncode, 0, "watermark signed with a 40-space salt")
            self.assertIn("ASSET_SALT is not set", res.stderr)
            self.assertFalse(os.path.exists(out), "a refused stamp must not write output")

            manifest = os.path.join(tmp, "m.json")
            res = subprocess.run([
                sys.executable, MANIFEST_SCRIPT, "--c1-doc", docs["c1"], "--c2-doc", docs["c2"],
                "--c3-doc", docs["c3"], "--ebook-doc", docs["ebook"], "--creator-id", "c",
                "--creator-name", "n", "--product-id", "p", "--output-manifest", manifest],
                capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=blank))
            self.assertNotEqual(res.returncode, 0, "manifest signed with a 40-space salt")
            self.assertIn("ASSET_SALT is not set", res.stderr)
            self.assertFalse(os.path.exists(manifest), "no manifest may be written with a blank salt")

    def test_short_salt_is_refused_by_both_scripts(self):
        """P2: ASSET_SALT must be at least 32 characters. A short salt makes the HMAC forgeable."""
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(src)
            docs = {}
            for name in ("c1", "c2", "c3", "ebook"):
                docs[name] = os.path.join(tmp, f"{name}.pdf")
                create_dummy_pdf(docs[name], name)
            for short in ("x", "a" * 31, " " + "a" * 30):
                with self.subTest(salt_length=len(short)):
                    res = subprocess.run(
                        [sys.executable, WATERMARK_SCRIPT, "--input", src, "--output", os.path.join(tmp, "o.pdf"),
                         "--creator-id", "c", "--creator-name", "n", "--mode", "perimeter", "--purpose", "review"],
                        capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=short))
                    self.assertNotEqual(res.returncode, 0, "watermark signed with a short salt")
                    self.assertIn("ASSET_SALT", res.stderr)
                    manifest = os.path.join(tmp, "m.json")
                    res = subprocess.run([
                        sys.executable, MANIFEST_SCRIPT, "--c1-doc", docs["c1"], "--c2-doc", docs["c2"],
                        "--c3-doc", docs["c3"], "--ebook-doc", docs["ebook"], "--creator-id", "c",
                        "--creator-name", "n", "--product-id", "p", "--output-manifest", manifest],
                        capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=short))
                    self.assertNotEqual(res.returncode, 0, "manifest signed with a short salt")
                    self.assertFalse(os.path.exists(manifest), "no manifest may be written with a short salt")

    def test_salt_of_exactly_32_characters_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(src)
            res = subprocess.run(
                [sys.executable, WATERMARK_SCRIPT, "--input", src, "--output", os.path.join(tmp, "o.pdf"),
                 "--creator-id", "c", "--creator-name", "n", "--mode", "perimeter", "--purpose", "review"],
                capture_output=True, text=True, env=dict(os.environ, ASSET_SALT="a" * 32))
            self.assertEqual(res.returncode, 0, res.stderr)

    def test_same_basename_sources_get_distinct_stamped_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1, d2 = os.path.join(tmp, "d1"), os.path.join(tmp, "d2")
            c1 = os.path.join(d2, "doc.pdf"); ebook = os.path.join(d1, "doc.pdf")
            create_dummy_pdf(c1, "C1 contract"); create_dummy_pdf(ebook, "ebook body")
            c2 = os.path.join(tmp, "c2.pdf"); c3 = os.path.join(tmp, "c3.pdf")
            create_dummy_pdf(c2, "C2"); create_dummy_pdf(c3, "C3")
            manifest = os.path.join(tmp, "m.json")
            res = subprocess.run([
                sys.executable, MANIFEST_SCRIPT, "--c1-doc", c1, "--c2-doc", c2, "--c3-doc", c3,
                "--ebook-doc", ebook, "--creator-id", "c", "--creator-name", "n", "--product-id", "p",
                "--output-manifest", manifest, "--output-dir", os.path.join(tmp, "out"), "--stamp-bundle"],
                capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)
            with open(manifest) as f:
                stamped = json.load(f)["stamped_artifacts"]
            self.assertEqual(len(set(stamped.values())), 4, f"stamped outputs collide: {stamped}")
            with open(c1, "rb") as f:
                c1_sha = hashlib.sha256(f.read()).hexdigest()
            self.assertEqual(pypdf.PdfReader(stamped["c1"]).metadata.get("/SourceSha256"), c1_sha)

    def test_watermark_refuses_to_overwrite_its_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(src)
            with open(src, "rb") as f:
                before = f.read()
            res = subprocess.run(
                [sys.executable, WATERMARK_SCRIPT, "--input", src, "--output", src,
                 "--creator-id", "c", "--creator-name", "n", "--mode", "diagonal"],
                capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=TEST_SALT))
            self.assertNotEqual(res.returncode, 0)
            with open(src, "rb") as f:
                self.assertEqual(f.read(), before, "source PDF was overwritten")


class TestManifestSignatureCoversEveryField(unittest.TestCase):
    """P1-1: the root signature covers every manifest field a reader relies on, and --verify rejects any change.

    Verifier exit codes: 0 = verified, 1 = signature mismatch (tampered), 2 = usage/salt error.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bundle_verify_")
        self.docs = {}
        for name in ("c1", "c2", "c3", "ebook"):
            self.docs[name] = os.path.join(self.tmp, f"{name}.pdf")
            create_dummy_pdf(self.docs[name], f"{name} body")
        self.manifest = os.path.join(self.tmp, "bundle_manifest.json")
        res = subprocess.run([
            sys.executable, MANIFEST_SCRIPT,
            "--c1-doc", self.docs["c1"], "--c2-doc", self.docs["c2"], "--c3-doc", self.docs["c3"],
            "--ebook-doc", self.docs["ebook"], "--creator-id", "example-creator", "--creator-name", "the owner",
            "--product-id", "500k-playbook", "--output-manifest", self.manifest,
            "--output-dir", os.path.join(self.tmp, "stamped"), "--stamp-bundle",
        ], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(self.manifest, encoding="utf-8") as f:
            self.original = json.load(f)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _verify(self, path):
        return subprocess.run([sys.executable, MANIFEST_SCRIPT, "--verify", path], capture_output=True, text=True)

    def _write(self, manifest, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
        return path

    def test_untouched_manifest_verifies(self):
        res = self._verify(self.manifest)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_reserialized_manifest_still_verifies(self):
        """The signed form is canonical: key order and whitespace must not matter."""
        path = os.path.join(self.tmp, "reserialized.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.original, f, sort_keys=True, separators=(",", ":"))
        res = self._verify(path)
        self.assertEqual(res.returncode, 0, res.stderr)

    @staticmethod
    def _leaves(node, path=()):
        """Yields (path, value) for every leaf of a nested manifest, so no field is hand-listed."""
        if isinstance(node, dict):
            for key in node:
                yield from TestManifestSignatureCoversEveryField._leaves(node[key], path + (key,))
        else:
            yield path, node

    def test_editing_every_leaf_fails_verification(self):
        leaves = list(self._leaves(self.original))
        # The generated manifest has 33 leaves, including the signature. Fewer means the walker lost fields.
        self.assertGreaterEqual(len(leaves), 33, f"walker found only {len(leaves)} leaves")
        for path, value in leaves:
            with self.subTest(field="/".join(path)):
                tampered = copy.deepcopy(self.original)
                node = tampered
                for key in path[:-1]:
                    node = node[key]
                if isinstance(value, bool):
                    node[path[-1]] = not value
                elif isinstance(value, str):
                    node[path[-1]] = value + "X"
                else:
                    self.fail(f"unexpected leaf type at {'/'.join(path)}: {type(value).__name__}")
                res = self._verify(self._write(tampered, os.path.join(self.tmp, "tampered.json")))
                self.assertEqual(res.returncode, 1, f"edit to {'/'.join(path)} was not rejected: {res.stdout} {res.stderr}")

    def test_added_or_removed_field_fails_verification(self):
        added = copy.deepcopy(self.original)
        added["reviewer"] = "someone"
        res = self._verify(self._write(added, os.path.join(self.tmp, "added.json")))
        self.assertEqual(res.returncode, 1, res.stderr)

        removed = copy.deepcopy(self.original)
        del removed["created_at"]
        res = self._verify(self._write(removed, os.path.join(self.tmp, "removed.json")))
        self.assertEqual(res.returncode, 1, res.stderr)


class TestVerifyExitCodes(unittest.TestCase):
    """P1: --verify exits 0 untouched, 1 tampered, 2 for any usage, read, parse, or salt error.

    Exit 1 means tampered and must never be produced by a read or parse failure.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bundle_exit_")
        docs = {}
        for name in ("c1", "c2", "c3", "ebook"):
            docs[name] = os.path.join(self.tmp, f"{name}.pdf")
            create_dummy_pdf(docs[name], f"{name} body")
        self.good = os.path.join(self.tmp, "bundle_manifest.json")
        res = subprocess.run([
            sys.executable, MANIFEST_SCRIPT,
            "--c1-doc", docs["c1"], "--c2-doc", docs["c2"], "--c3-doc", docs["c3"],
            "--ebook-doc", docs["ebook"], "--creator-id", "example-creator", "--creator-name", "the owner",
            "--product-id", "500k-playbook", "--output-manifest", self.good,
        ], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _verify(self, path, env=None):
        return subprocess.run(
            [sys.executable, MANIFEST_SCRIPT, "--verify", path],
            capture_output=True, text=True,
            env=env if env is not None else dict(os.environ),
        )

    def _assert_usage_error(self, res, label):
        self.assertEqual(res.returncode, 2, f"{label}: expected exit 2, got {res.returncode}; stderr={res.stderr!r}")
        self.assertNotIn("Traceback", res.stderr, f"{label}: a raw traceback leaked to stderr")
        self.assertEqual(len(res.stderr.strip().splitlines()), 1, f"{label}: expected one line, got {res.stderr!r}")

    def test_missing_file_exits_2(self):
        res = self._verify(os.path.join(self.tmp, "does_not_exist.json"))
        self._assert_usage_error(res, "missing file")

    def test_malformed_json_exits_2(self):
        bad = os.path.join(self.tmp, "malformed.json")
        with open(bad, "w", encoding="utf-8") as f:
            f.write('{"bundle_id": ')
        self._assert_usage_error(self._verify(bad), "malformed JSON")

    def test_undecodable_bytes_exit_2(self):
        bad = os.path.join(self.tmp, "binary.json")
        with open(bad, "wb") as f:
            f.write(b"\xff\xfe\x00\x81")
        self._assert_usage_error(self._verify(bad), "undecodable bytes")

    def test_non_object_json_exits_2(self):
        for label, body in (("array", "[1, 2]"), ("string", '"x"'), ("null", "null")):
            with self.subTest(body=label):
                path = os.path.join(self.tmp, f"non_object_{label}.json")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(body)
                self._assert_usage_error(self._verify(path), f"non-object JSON ({label})")

    def test_unset_salt_exits_2(self):
        env = {k: v for k, v in os.environ.items() if k != "ASSET_SALT"}
        self._assert_usage_error(self._verify(self.good, env), "unset salt")

    def test_short_salt_exits_2(self):
        env = dict(os.environ, ASSET_SALT="a" * 31)
        self._assert_usage_error(self._verify(self.good, env), "31-character salt")

    def test_forty_space_salt_exits_2(self):
        """A blank salt of valid length is refused by the strip rule alone."""
        env = dict(os.environ, ASSET_SALT=" " * 40)
        self._assert_usage_error(self._verify(self.good, env), "40-space salt")

    def test_untouched_manifest_still_exits_0(self):
        res = self._verify(self.good)
        self.assertEqual(res.returncode, 0, res.stderr)


class TestStamperRefusesDiagonalOnContracts(unittest.TestCase):
    """P2: diagonal stamping is for media only. The stamper refuses it on any contract document."""

    @staticmethod
    def _contract_purposes():
        """The contract list comes from the stamper's own constant, never a copy in this test."""
        spec = importlib.util.spec_from_file_location("watermark_pdf", WATERMARK_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return sorted(module.CONTRACT_PURPOSES)

    def test_diagonal_stamp_on_each_contract_purpose_is_refused(self):
        purposes = self._contract_purposes()
        self.assertTrue(purposes, "CONTRACT_PURPOSES is empty; the refusal would not be tested")
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "contract.pdf")
            create_dummy_pdf(src)
            for purpose in purposes:
                with self.subTest(purpose=purpose):
                    out = os.path.join(tmp, f"{purpose}.pdf")
                    res = subprocess.run(
                        [sys.executable, WATERMARK_SCRIPT, "--input", src, "--output", out,
                         "--creator-id", "c", "--creator-name", "n", "--mode", "diagonal",
                         "--purpose", purpose, "--bundle-id", "BND-TEST-002"],
                        capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=TEST_SALT))
                    self.assertNotEqual(res.returncode, 0, f"diagonal stamp on contract purpose {purpose} exited 0")
                    self.assertIn(f"diagonal stamping is refused for contract purpose '{purpose}'", res.stderr)
                    self.assertFalse(os.path.exists(out), "a refused stamp must not write output")

    def test_every_contract_purpose_is_an_accepted_argparse_choice(self):
        """A purpose in CONTRACT_PURPOSES must also be accepted by --purpose, or it can never be stamped."""
        purposes = self._contract_purposes()
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "contract.pdf")
            create_dummy_pdf(src)
            for purpose in purposes:
                with self.subTest(purpose=purpose):
                    out = os.path.join(tmp, f"{purpose}.perimeter.pdf")
                    res = subprocess.run(
                        [sys.executable, WATERMARK_SCRIPT, "--input", src, "--output", out,
                         "--creator-id", "c", "--creator-name", "n", "--mode", "perimeter",
                         "--purpose", purpose, "--bundle-id", "BND-TEST-002"],
                        capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=TEST_SALT))
                    self.assertEqual(res.returncode, 0, f"perimeter stamp rejected for {purpose}: {res.stderr}")


class TestStampedBytesAreTheHashedBytes(unittest.TestCase):
    """P1-2: a source replaced after it was hashed must not make the stamped output differ from the signed digest."""

    PAIRS = (
        ("c1", "c1_data_accuracy"), ("c2", "c2_release_approval"),
        ("c3", "c3_publisher_agreement"), ("ebook", "ebook_asset"),
    )

    def _create_bundle_with_swap(self, gbm, swap_key):
        """Hashes every source, then replaces the swap_key source before the first stamping subprocess runs."""
        real_run = subprocess.run
        with tempfile.TemporaryDirectory() as tmp:
            docs = {name: os.path.join(tmp, f"{name}.pdf") for name in ("c1", "c2", "c3", "ebook")}
            for name, path in docs.items():
                create_dummy_pdf(path, f"{name} original")
            original = {}
            for name, path in docs.items():
                with open(path, "rb") as f:
                    original[name] = hashlib.sha256(f.read()).hexdigest()

            swapped = {"done": False}

            def swap_then_run(cmd, *args, **kwargs):
                if not swapped["done"]:
                    swapped["done"] = True
                    create_dummy_pdf(docs[swap_key], f"{swap_key} SWAPPED after hashing")
                return real_run(cmd, *args, **kwargs)

            with unittest.mock.patch.object(gbm.subprocess, "run", side_effect=swap_then_run):
                manifest = gbm.create_bundle(
                    docs["c1"], docs["c2"], docs["c3"], docs["ebook"],
                    "example-creator", "the owner", "500k-playbook",
                    os.path.join(tmp, "manifest.json"), output_dir=os.path.join(tmp, "out"), stamp_bundle=True,
                )
            # Read the stamped outputs here: the temporary directory is removed when this block exits.
            stamped_sha = {
                key: pypdf.PdfReader(path).metadata.get("/SourceSha256")
                for key, path in manifest["stamped_artifacts"].items()
            }
            return swapped["done"], original, manifest, stamped_sha

    def test_source_swapped_between_hash_and_stamp_is_not_what_gets_stamped(self):
        spec = importlib.util.spec_from_file_location("generate_bundle_manifest", MANIFEST_SCRIPT)
        gbm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gbm)
        for swap_key, artifact in self.PAIRS:
            with self.subTest(swapped_source=swap_key):
                swapped, original, manifest, stamped_sha = self._create_bundle_with_swap(gbm, swap_key)
                self.assertTrue(swapped, f"the {swap_key} swap never ran; the test proves nothing")
                signed = manifest["artifacts"][artifact]["sha256"]
                self.assertEqual(signed, original[swap_key], f"{artifact}: signed digest is not the hashed bytes")
                self.assertEqual(stamped_sha[swap_key], signed, f"{artifact}: stamped bytes differ from the signed digest")


if __name__ == "__main__":
    unittest.main()
