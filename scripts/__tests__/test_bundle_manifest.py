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
import datetime
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import types
import unittest.mock
import pypdf

TEST_SALT = "test-only-salt-that-is-at-least-32-chars"  # 40 characters; the scripts refuse anything shorter
# Assign, do not setdefault: a developer's shell ASSET_SALT would otherwise sign the fixtures, and a short one
# would fail every generation test.
os.environ["ASSET_SALT"] = TEST_SALT

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
        self.assertIsNotNone(meta.get("/ProvenanceFingerprint"))
        # Metadata alone also passes if the overlay merge is skipped, so the visible audit banner is asserted too.
        self.assertIn("EXPANPRESS EXECUTION BUNDLE", reader.pages[0].extract_text())

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
        self.assertIn("CONFIDENTIAL REVIEW COPY", reader.pages[0].extract_text())

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
        self.assertEqual(manifest["status"], "PENDING_LAUNCH_GATE")

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

    def _manifest_for(self, c1, c2, c3, ebook, name):
        out = os.path.join(self.test_dir, f"{name}.json")
        res = subprocess.run([
            sys.executable, MANIFEST_SCRIPT, "--c1-doc", c1, "--c2-doc", c2, "--c3-doc", c3,
            "--ebook-doc", ebook, "--creator-id", "example-creator", "--creator-name", "the owner",
            "--product-id", "500k-playbook", "--output-manifest", out], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(out, encoding="utf-8") as f:
            return json.load(f), out

    def _verify_file(self, path):
        return subprocess.run([sys.executable, MANIFEST_SCRIPT, "--verify", path],
                              capture_output=True, text=True).returncode

    def _verify_spliced(self, baseline, artifact, sha, name):
        """Verifies the baseline manifest with one artifact digest replaced and the baseline signature kept.

        Timestamps differ between runs, so comparing two independent signatures proves nothing. Keeping the
        baseline signature isolates the digest: only a signature that covers the digest can reject this.
        """
        spliced = copy.deepcopy(baseline)
        spliced["artifacts"][artifact]["sha256"] = sha
        path = os.path.join(self.test_dir, f"{name}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(spliced, f)
        return self._verify_file(path)

    def test_tamper_detection(self):
        """A changed e-book digest must be rejected under the baseline root signature."""
        base, _ = self._manifest_for(self.c1_pdf, self.c2_pdf, self.c3_pdf, self.ebook_pdf, "base")
        tampered_ebook = os.path.join(self.test_dir, "ebook_tampered.pdf")
        create_dummy_pdf(tampered_ebook, "TAMPERED: Altered royalties clause or contents!")
        altered, altered_path = self._manifest_for(self.c1_pdf, self.c2_pdf, self.c3_pdf, tampered_ebook, "altered")
        self.assertEqual(self._verify_file(altered_path), 0, "the altered manifest must verify with its own signature")
        new_sha = altered["artifacts"]["ebook_asset"]["sha256"]
        self.assertNotEqual(new_sha, base["artifacts"]["ebook_asset"]["sha256"])
        self.assertEqual(self._verify_spliced(base, "ebook_asset", new_sha, "splice_ebook"), 1,
                         "a changed e-book digest verified under the baseline signature")

    def test_each_contract_change_breaks_the_signed_digest(self):
        base, _ = self._manifest_for(self.c1_pdf, self.c2_pdf, self.c3_pdf, self.ebook_pdf, "base")
        for key, artifact, idx in (("c1", "c1_data_accuracy", 0), ("c2", "c2_release_approval", 1),
                                   ("c3", "c3_publisher_agreement", 2)):
            with self.subTest(source=key):
                docs = [self.c1_pdf, self.c2_pdf, self.c3_pdf]
                altered_doc = os.path.join(self.test_dir, f"{key}_altered.pdf")
                create_dummy_pdf(altered_doc, f"{key} altered clause")
                docs[idx] = altered_doc
                altered, _ = self._manifest_for(*docs, self.ebook_pdf, f"alt_{key}")
                new_sha = altered["artifacts"][artifact]["sha256"]
                self.assertNotEqual(new_sha, base["artifacts"][artifact]["sha256"])
                self.assertEqual(self._verify_spliced(base, artifact, new_sha, f"splice_{key}"), 1,
                                 f"altering {key} verified under the baseline signature")

    def test_failed_stamp_raises_and_writes_no_manifest(self):
        spec = importlib.util.spec_from_file_location("generate_bundle_manifest", MANIFEST_SCRIPT)
        gbm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gbm)
        real_run = subprocess.run

        def failing_stamp(cmd, *args, **kwargs):
            if os.path.basename(str(cmd[1])) == "watermark_pdf.py":
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="stamp boom")
            return real_run(cmd, *args, **kwargs)

        manifest_path = os.path.join(self.test_dir, "failed_stamp.json")
        with unittest.mock.patch.object(gbm.subprocess, "run", side_effect=failing_stamp):
            with self.assertRaisesRegex(RuntimeError, "Failed to stamp"):
                gbm.create_bundle(self.c1_pdf, self.c2_pdf, self.c3_pdf, self.ebook_pdf,
                                  "example-creator", "the owner", "500k-playbook", manifest_path,
                                  output_dir=os.path.join(self.test_dir, "failed_out"), stamp_bundle=True)
        self.assertFalse(os.path.exists(manifest_path), "a failed stamp must not leave a signed manifest")


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

    def test_manifest_salt_boundary_refuses_31_and_accepts_32(self):
        """The manifest path must enforce the same 32-character floor as the watermarker."""
        with tempfile.TemporaryDirectory() as tmp:
            docs = {}
            for name in ("c1", "c2", "c3", "ebook"):
                docs[name] = os.path.join(tmp, f"{name}.pdf")
                create_dummy_pdf(docs[name], name)
            manifest = os.path.join(tmp, "m.json")

            def generate(salt):
                return subprocess.run([
                    sys.executable, MANIFEST_SCRIPT, "--c1-doc", docs["c1"], "--c2-doc", docs["c2"],
                    "--c3-doc", docs["c3"], "--ebook-doc", docs["ebook"], "--creator-id", "c",
                    "--creator-name", "n", "--product-id", "p", "--output-manifest", manifest],
                    capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=salt))

            res = generate("a" * 31)
            self.assertNotEqual(res.returncode, 0, "manifest signed with a 31-character salt")
            self.assertIn("ASSET_SALT is not set", res.stderr)
            self.assertFalse(os.path.exists(manifest), "no manifest may be written with a 31-character salt")

            res = generate("a" * 32)
            self.assertEqual(res.returncode, 0, f"a 32-character salt must be accepted: {res.stderr}")
            verify = subprocess.run([sys.executable, MANIFEST_SCRIPT, "--verify", manifest],
                                    capture_output=True, text=True, env=dict(os.environ, ASSET_SALT="a" * 32))
            self.assertEqual(verify.returncode, 0, verify.stderr)

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

    Verifier exit codes: 0 = verified, 1 = signature mismatch (tampered), 2 = usage, read, parse or salt error.
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

    def test_wrong_salt_of_valid_length_is_tampered_not_usage(self):
        """A valid-length salt that differs from the signing salt is a verdict (exit 1), not a usage error."""
        self.assertEqual(self._verify(self.good, dict(os.environ, ASSET_SALT="b" * 32)).returncode, 1)

    def test_missing_or_non_string_signature_is_tampered_without_traceback(self):
        with open(self.good, encoding="utf-8") as f:
            base = json.load(f)
        cases = {
            "missing": lambda m: m.pop("bundle_root_signature"),
            "number": lambda m: m.__setitem__("bundle_root_signature", 123),
            "null": lambda m: m.__setitem__("bundle_root_signature", None),
        }
        for label, mutate in cases.items():
            with self.subTest(signature=label):
                manifest = copy.deepcopy(base)
                mutate(manifest)
                path = os.path.join(self.tmp, f"sig_{label}.json")
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(manifest, f)
                res = self._verify(path)
                self.assertEqual(res.returncode, 1, res.stderr)
                self.assertNotIn("Traceback", res.stderr)

    def test_verify_help_documents_exit_2(self):
        """The --verify help must name every exit code, including the usage, read, parse and salt error."""
        res = subprocess.run([sys.executable, MANIFEST_SCRIPT, "--help"], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("2 usage, read, parse or salt error", " ".join(res.stdout.split()))

    def test_untouched_manifest_still_exits_0(self):
        res = self._verify(self.good)
        self.assertEqual(res.returncode, 0, res.stderr)


class TestVerifyChecksReferencedFiles(unittest.TestCase):
    """High: a valid root signature is not enough. --verify must also reject a source or stamped file that changed or vanished."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bundle_refs_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
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
            self.stamped = json.load(f)["stamped_artifacts"]

    def _verify(self):
        return subprocess.run([sys.executable, MANIFEST_SCRIPT, "--verify", self.manifest],
                              capture_output=True, text=True)

    def test_untouched_bundle_verifies(self):
        self.assertEqual(self._verify().returncode, 0)

    def test_changed_source_fails_verification(self):
        create_dummy_pdf(self.docs["c1"], "c1 REPLACED after signing")
        res = self._verify()
        self.assertEqual(res.returncode, 1, f"a changed source still verified: {res.stdout} {res.stderr}")
        self.assertIn("c1_data_accuracy", res.stderr)

    def test_removed_source_fails_verification(self):
        os.remove(self.docs["c2"])
        res = self._verify()
        self.assertEqual(res.returncode, 1, f"a removed source still verified: {res.stdout} {res.stderr}")

    def test_replaced_stamped_file_fails_verification(self):
        create_dummy_pdf(self.stamped["c1"], "stamped copy swapped out")
        res = self._verify()
        self.assertEqual(res.returncode, 1, f"a replaced stamped file still verified: {res.stdout} {res.stderr}")

    def test_removed_stamped_file_fails_verification(self):
        os.remove(self.stamped["ebook"])
        res = self._verify()
        self.assertEqual(res.returncode, 1, f"a removed stamped file still verified: {res.stdout} {res.stderr}")


class TestManifestParsingIsStrict(unittest.TestCase):
    """High: a duplicate key is rejected, not last-wins. Every parse or encoding failure is exit 2, never a traceback or a tamper verdict."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bundle_strict_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        docs = {}
        for name in ("c1", "c2", "c3", "ebook"):
            docs[name] = os.path.join(self.tmp, f"{name}.pdf")
            create_dummy_pdf(docs[name], f"{name} body")
        self.good = os.path.join(self.tmp, "bundle_manifest.json")
        res = subprocess.run([
            sys.executable, MANIFEST_SCRIPT, "--c1-doc", docs["c1"], "--c2-doc", docs["c2"], "--c3-doc", docs["c3"],
            "--ebook-doc", docs["ebook"], "--creator-id", "example-creator", "--creator-name", "the owner",
            "--product-id", "500k-playbook", "--output-manifest", self.good,
        ], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(self.good, encoding="utf-8") as f:
            self.text = f.read()

    def _verify_text(self, text):
        path = os.path.join(self.tmp, "candidate.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return subprocess.run([sys.executable, MANIFEST_SCRIPT, "--verify", path], capture_output=True, text=True)

    def test_untouched_text_still_verifies(self):
        self.assertEqual(self._verify_text(self.text).returncode, 0)

    def test_duplicate_top_level_key_is_rejected_not_last_wins(self):
        forged = self.text.replace("{", '{"bundle_id": "BND-FORGED", ', 1)
        res = self._verify_text(forged)
        self.assertEqual(res.returncode, 2, f"duplicate key was not rejected: rc={res.returncode} {res.stdout} {res.stderr}")
        self.assertNotIn("Traceback", res.stderr)

    def test_duplicate_nested_key_is_rejected(self):
        forged = self.text.replace('"creator": {', '"creator": {"id": "forged", ', 1)
        res = self._verify_text(forged)
        self.assertEqual(res.returncode, 2, f"nested duplicate key was not rejected: {res.stdout} {res.stderr}")

    def test_nan_constant_is_a_parse_error(self):
        res = self._verify_text(self.text.replace('"product_id": "500k-playbook"', '"product_id": NaN', 1))
        self.assertEqual(res.returncode, 2, f"NaN was accepted: rc={res.returncode} {res.stderr}")
        self.assertNotIn("Traceback", res.stderr)

    def test_deeply_nested_manifest_is_a_parse_error(self):
        deep = '"deep": ' + "[" * 100000 + "]" * 100000 + ", "
        res = self._verify_text(self.text.replace("{", "{" + deep, 1))
        self.assertEqual(res.returncode, 2, f"deep nesting exited {res.returncode}: {res.stderr[-300:]}")
        self.assertNotIn("Traceback", res.stderr)

    def test_non_ascii_signature_is_a_tamper_verdict_not_a_crash(self):
        manifest = json.loads(self.text)
        manifest["bundle_root_signature"] = "sígnature-é"
        res = self._verify_text(json.dumps(manifest, ensure_ascii=False))
        self.assertEqual(res.returncode, 1, f"rc={res.returncode}: {res.stderr[-300:]}")
        self.assertNotIn("Traceback", res.stderr)

    def test_lone_surrogate_in_a_field_is_a_parse_error(self):
        res = self._verify_text(self.text.replace('"product_id": "500k-playbook"', '"product_id": "\\udc80"', 1))
        self.assertEqual(res.returncode, 2, f"lone surrogate exited {res.returncode}: {res.stderr[-300:]}")
        self.assertNotIn("Traceback", res.stderr)


class TestProvenanceFingerprintCoversBundleRoot(unittest.TestCase):
    """High: the provenance HMAC must cover the bundle root it is stamped with. Otherwise the root can change without breaking the fingerprint."""

    FIXED_NOW = datetime.datetime(2026, 11, 2, 12, 0, 0, tzinfo=datetime.timezone.utc)

    def _stamp_with_root(self, src, out, root):
        """Runs the stamper in-process with the clock frozen, so only the bundle root differs between calls."""
        spec = importlib.util.spec_from_file_location("watermark_pdf", WATERMARK_SCRIPT)
        wm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(wm)
        frozen_now = self.FIXED_NOW

        class FrozenDatetime(datetime.datetime):
            @classmethod
            def now(cls, tz=None):
                return frozen_now

        argv = ["watermark_pdf.py", "--input", src, "--output", out, "--creator-id", "c",
                "--creator-name", "n", "--mode", "perimeter", "--purpose", "review", "--bundle-root-hash", root]
        with unittest.mock.patch.object(wm, "datetime", types.SimpleNamespace(datetime=FrozenDatetime, timezone=datetime.timezone)), \
                unittest.mock.patch.object(sys, "argv", argv):
            wm.main()
        return pypdf.PdfReader(out).metadata

    def test_changing_the_bundle_root_changes_the_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(src, "x")
            first = self._stamp_with_root(src, os.path.join(tmp, "a.pdf"), "a" * 64)
            second = self._stamp_with_root(src, os.path.join(tmp, "b.pdf"), "b" * 64)
            self.assertEqual(first["/BundleRootHash"], "a" * 64)
            self.assertEqual(second["/BundleRootHash"], "b" * 64)
            self.assertNotEqual(first["/ProvenanceFingerprint"], second["/ProvenanceFingerprint"],
                                "the provenance fingerprint does not cover the bundle root it is stamped with")


class TestStampReadsTheSourceOnce(unittest.TestCase):
    """Medium: the digest written to /SourceSha256 must describe the bytes the PDF parser reads, not a second read of the path."""

    @staticmethod
    def _load_watermarker():
        spec = importlib.util.spec_from_file_location("watermark_pdf", WATERMARK_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_parser_consumes_the_bytes_that_were_hashed(self):
        wm = self._load_watermarker()
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(src, "original")
            out = os.path.join(tmp, "o.pdf")
            seen = {}
            real_reader = pypdf.PdfReader

            def spy(stream, *args, **kwargs):
                if "parsed" not in seen:
                    if isinstance(stream, str):
                        # The old code reopens the path here: swap the file first to simulate a concurrent replacement.
                        create_dummy_pdf(src, "swapped in after hashing")
                        with open(stream, "rb") as f:
                            seen["parsed"] = f.read()
                    else:
                        seen["parsed"] = stream.getvalue()
                return real_reader(stream, *args, **kwargs)

            argv = ["watermark_pdf.py", "--input", src, "--output", out, "--creator-id", "c",
                    "--creator-name", "n", "--mode", "perimeter", "--purpose", "review", "--bundle-id", "BND-T-9"]
            with unittest.mock.patch.object(pypdf, "PdfReader", side_effect=spy), \
                    unittest.mock.patch.object(sys, "argv", argv):
                wm.main()
            self.assertIn("parsed", seen)
            parsed_sha = hashlib.sha256(seen["parsed"]).hexdigest()
            self.assertEqual(real_reader(out).metadata.get("/SourceSha256"), parsed_sha,
                             "/SourceSha256 describes different bytes from the ones the parser read")


class TestOverlayStreamsAreLatin1Exact(unittest.TestCase):
    """Medium/Low: overlay streams must be encodable, and /Length must count the bytes actually written."""

    @staticmethod
    def _assert_length_matches(testcase, pdf: bytes):
        m = re.search(rb"/Length (\d+) >>\nstream\n", pdf)
        testcase.assertIsNotNone(m, "no stream length found")
        end = pdf.index(b"endstream", m.end())
        testcase.assertEqual(int(m.group(1)), end - m.end(), "declared /Length differs from the stream bytes written")

    def test_perimeter_length_counts_latin1_bytes(self):
        wm = TestStampReadsTheSourceOnce._load_watermarker()
        pdf = wm.generate_perimeter_overlay_pdf(612, 792, "BND-T-9", "abcd", "Zoé", 1, 1)
        self._assert_length_matches(self, pdf)

    def test_diagonal_length_counts_latin1_bytes(self):
        wm = TestStampReadsTheSourceOnce._load_watermarker()
        pdf = wm.generate_diagonal_overlay_pdf(612, 792, "CONFIDENTIAL REVIEW COPY - ZOÉ")
        self._assert_length_matches(self, pdf)

    def test_non_latin1_creator_name_stamps_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(src, "x")
            out = os.path.join(tmp, "o.pdf")
            for mode, purpose in (("perimeter", "c1_data_accuracy"), ("diagonal", "review")):
                with self.subTest(mode=mode):
                    res = subprocess.run(
                        [sys.executable, WATERMARK_SCRIPT, "--input", src, "--output", out, "--creator-id", "c",
                         "--creator-name", "Zoé Ω 漢", "--mode", mode, "--purpose", purpose],
                        capture_output=True, text=True, env=dict(os.environ, ASSET_SALT=TEST_SALT))
                    self.assertEqual(res.returncode, 0, f"{mode} stamp crashed: {res.stderr[-300:]}")
                    self.assertTrue(pypdf.PdfReader(out).metadata.get("/Author", "").startswith("Zo"))


class TestBundlePublishIsAtomicAndBounded(unittest.TestCase):
    """Medium: a failed run publishes no partial bundle, stamped paths are absolute, and sources are not held in memory."""

    @staticmethod
    def _load_generator():
        spec = importlib.util.spec_from_file_location("generate_bundle_manifest", MANIFEST_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _docs(self, tmp):
        docs = {}
        for name in ("c1", "c2", "c3", "ebook"):
            docs[name] = os.path.join(tmp, f"{name}.pdf")
            create_dummy_pdf(docs[name], f"{name} body")
        return docs

    def test_failed_fourth_stamp_publishes_no_stamped_outputs(self):
        gbm = self._load_generator()
        real_run = subprocess.run
        calls = {"stamps": 0}

        def fail_on_fourth_stamp(cmd, *args, **kwargs):
            if os.path.basename(str(cmd[1])) == "watermark_pdf.py":
                calls["stamps"] += 1
                if calls["stamps"] == 4:
                    return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="ebook stamp boom")
            return real_run(cmd, *args, **kwargs)

        with tempfile.TemporaryDirectory() as tmp:
            docs = self._docs(tmp)
            out_dir = os.path.join(tmp, "out")
            manifest = os.path.join(tmp, "m.json")
            with unittest.mock.patch.object(gbm.subprocess, "run", side_effect=fail_on_fourth_stamp):
                with self.assertRaisesRegex(RuntimeError, "Failed to stamp ebook"):
                    gbm.create_bundle(docs["c1"], docs["c2"], docs["c3"], docs["ebook"], "example-creator",
                                      "the owner", "500k-playbook", manifest, output_dir=out_dir, stamp_bundle=True)
            self.assertEqual(calls["stamps"], 4, "the failure was not on the fourth stamp")
            published = sorted(n for n in os.listdir(out_dir) if n.endswith(".bundle_stamped.pdf"))
            self.assertEqual(published, [], f"a failed run left stamped outputs at their final paths: {published}")
            self.assertFalse(os.path.exists(manifest))

    def test_relative_output_dir_yields_absolute_stamped_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._docs(tmp)
            res = subprocess.run([
                sys.executable, MANIFEST_SCRIPT, "--c1-doc", docs["c1"], "--c2-doc", docs["c2"], "--c3-doc", docs["c3"],
                "--ebook-doc", docs["ebook"], "--creator-id", "c", "--creator-name", "n", "--product-id", "p",
                "--output-manifest", "m.json", "--output-dir", "out", "--stamp-bundle"],
                capture_output=True, text=True, cwd=tmp)
            self.assertEqual(res.returncode, 0, res.stderr)
            with open(os.path.join(tmp, "m.json"), encoding="utf-8") as f:
                stamped = json.load(f)["stamped_artifacts"]
            self.assertEqual(len(stamped), 4)
            for key, path in stamped.items():
                self.assertTrue(os.path.isabs(path), f"{key} stamped path is relative: {path}")

    def test_stamp_subprocess_has_a_timeout_and_a_timeout_fails_the_bundle(self):
        """Medium: a stuck stamper must fail the bundle, not hang it. The subprocess call carries a finite timeout."""
        gbm = self._load_generator()
        real_run = subprocess.run
        seen = {}

        def stuck_stamp(cmd, *args, **kwargs):
            if os.path.basename(str(cmd[1])) == "watermark_pdf.py":
                seen["timeout"] = kwargs.get("timeout")
                raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout") or 0)
            return real_run(cmd, *args, **kwargs)

        with tempfile.TemporaryDirectory() as tmp:
            docs = self._docs(tmp)
            manifest = os.path.join(tmp, "m.json")
            with unittest.mock.patch.object(gbm.subprocess, "run", side_effect=stuck_stamp):
                with self.assertRaisesRegex(RuntimeError, "Failed to stamp c1.*timed out"):
                    gbm.create_bundle(docs["c1"], docs["c2"], docs["c3"], docs["ebook"], "example-creator",
                                      "the owner", "500k-playbook", manifest,
                                      output_dir=os.path.join(tmp, "out"), stamp_bundle=True)
            self.assertIsInstance(seen.get("timeout"), (int, float), "the stamp subprocess was started without a timeout")
            self.assertGreater(seen["timeout"], 0)
            self.assertFalse(os.path.exists(manifest), "a timed-out stamp must not leave a manifest")

    def test_creator_name_that_looks_like_an_option_is_stamped_literally(self):
        """Medium: values pass as --flag=value, so a name starting with '-' or holding shell syntax is data, never an option or a command."""
        gbm = self._load_generator()
        # No space in the name: argparse reads a '-'-prefixed token that contains a space as a value, so only a
        # space-free token reaches the option-parsing path that this test is about.
        name = "-Jane$(touch${IFS}INJECTED_MARK)"
        with tempfile.TemporaryDirectory() as tmp:
            docs = self._docs(tmp)
            manifest = os.path.join(tmp, "m.json")
            cwd = os.getcwd()
            real_run = subprocess.run
            argvs = []

            def record(cmd, *args, **kwargs):
                argvs.append(list(cmd))
                return real_run(cmd, *args, **kwargs)

            os.chdir(tmp)
            try:
                with unittest.mock.patch.object(gbm.subprocess, "run", side_effect=record):
                    gbm.create_bundle(docs["c1"], docs["c2"], docs["c3"], docs["ebook"], "example-creator", name,
                                      "500k-playbook", manifest, output_dir=os.path.join(tmp, "out"), stamp_bundle=True)
            finally:
                os.chdir(cwd)
            self.assertEqual(len(argvs), 4)
            for argv in argvs:
                self.assertFalse(any(name in token or "INJECTED" in token for token in argv),
                                 f"the creator name reached the stamper's argv: {argv}")
            self.assertFalse(os.path.exists(os.path.join(tmp, "INJECTED_MARK")), "a shell ran on the creator name")
            with open(manifest, encoding="utf-8") as f:
                stamped = json.load(f)["stamped_artifacts"]
            self.assertEqual(pypdf.PdfReader(stamped["c1"]).metadata.get("/Author"), name)

    def test_hashing_large_sources_does_not_hold_them_in_memory(self):
        import tracemalloc
        gbm = self._load_generator()
        size = 8 * 1024 * 1024
        with tempfile.TemporaryDirectory() as tmp:
            docs = {}
            for name in ("c1", "c2", "c3", "ebook"):
                docs[name] = os.path.join(tmp, f"{name}.pdf")
                with open(docs[name], "wb") as f:
                    f.write(b"x" * size)
            tracemalloc.start()
            try:
                gbm.create_bundle(docs["c1"], docs["c2"], docs["c3"], docs["ebook"], "c", "n", "p",
                                  os.path.join(tmp, "m.json"))
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
        self.assertLess(peak, 4 * 1024 * 1024, f"peak {peak} bytes: the four {size}-byte sources were held whole")


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


class TestLaunchGateClaimsAreNotOverstated(unittest.TestCase):
    """High: the manifest must not sign a launch-gate result or a legal-text check that the generator never computed."""

    def test_identical_c2_and_ebook_does_not_sign_a_passed_gate(self):
        tmp = tempfile.mkdtemp(prefix="bundle_gate_")
        self.addCleanup(shutil.rmtree, tmp, True)
        same = os.path.join(tmp, "same.pdf")  # C2 and the e-book are the same bytes: the case the finding names
        create_dummy_pdf(same, "identical release bytes")
        c1, c3 = os.path.join(tmp, "c1.pdf"), os.path.join(tmp, "c3.pdf")
        create_dummy_pdf(c1, "c1 body")
        create_dummy_pdf(c3, "c3 body")
        manifest_path = os.path.join(tmp, "m.json")
        res = subprocess.run([
            sys.executable, MANIFEST_SCRIPT, "--c1-doc", c1, "--c2-doc", same, "--c3-doc", c3,
            "--ebook-doc", same, "--creator-id", "example-creator", "--creator-name", "the owner",
            "--product-id", "500k-playbook", "--output-manifest", manifest_path], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertTrue(manifest["artifacts"]["c2_release_approval"]["identical_to_asset_binary"])
        self.assertFalse(manifest["security_policy"]["launch_gate_verified"], "the generator never runs the launch gate")
        self.assertFalse(manifest["security_policy"]["zero_obscured_legal_text"], "the generator never checks page content")
        self.assertEqual(manifest["status"], "PENDING_LAUNCH_GATE")


class TestSaltHelperHasOneHome(unittest.TestCase):
    """P3: the salt rule lives in one module that both scripts import, so the refusal cannot drift apart."""

    @staticmethod
    def _load(path, name):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_both_scripts_use_the_shared_salt_function(self):
        scripts_dir = os.path.dirname(MANIFEST_SCRIPT)
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        shared = importlib.import_module("bundle_salt")
        gbm = self._load(MANIFEST_SCRIPT, "generate_bundle_manifest")
        wm = self._load(WATERMARK_SCRIPT, "watermark_pdf")
        self.assertIs(gbm.fingerprint_salt, shared.fingerprint_salt, "generate_bundle_manifest has its own salt helper")
        self.assertIs(wm.fingerprint_salt, shared.fingerprint_salt, "watermark_pdf has its own salt helper")

    def test_salt_function_is_defined_in_exactly_one_script_file(self):
        scripts_dir = os.path.dirname(MANIFEST_SCRIPT)
        definers = []
        for name in sorted(os.listdir(scripts_dir)):
            if name.endswith(".py"):
                with open(os.path.join(scripts_dir, name), encoding="utf-8") as f:
                    if "def fingerprint_salt(" in f.read():
                        definers.append(name)
        self.assertEqual(len(definers), 1, f"fingerprint_salt is defined in {definers}")


def _file_digest(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class TestOutputPathsNeverOverwriteSources(unittest.TestCase):
    """A destination that is a source document, or that another output names, is refused before any write."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        patch = unittest.mock.patch.dict(os.environ, {"ASSET_SALT": TEST_SALT})
        patch.start()
        self.addCleanup(patch.stop)
        spec = importlib.util.spec_from_file_location("generate_bundle_manifest", MANIFEST_SCRIPT)
        self.gbm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.gbm)
        self.src_dir = os.path.join(self.tmp, "src")
        os.makedirs(self.src_dir)
        self.docs = {}
        for key in ("c1", "c2", "c3", "ebook"):
            path = os.path.join(self.src_dir, f"{key}.pdf")
            create_dummy_pdf(path, key)
            self.docs[key] = path

    def _bundle(self, output_manifest, output_dir=None, stamp=False, docs=None):
        d = docs or self.docs
        return self.gbm.create_bundle(d["c1"], d["c2"], d["c3"], d["ebook"], "example-creator", "the owner",
                                      "sample-product", output_manifest, output_dir=output_dir, stamp_bundle=stamp)

    def test_manifest_path_that_is_a_source_is_refused_and_source_is_untouched(self):
        before = _file_digest(self.docs["c1"])
        with self.assertRaisesRegex(ValueError, "source document c1"):
            self._bundle(output_manifest=self.docs["c1"])
        self.assertEqual(_file_digest(self.docs["c1"]), before, "the source must not be overwritten")

    def test_stamped_output_that_is_another_source_is_refused_before_any_stamp(self):
        out_dir = os.path.join(self.tmp, "out")
        os.makedirs(out_dir)
        # c1's stamped output is out/c1_doc.bundle_stamped.pdf. Make that the ebook source, so a stamp would overwrite it.
        doc1 = os.path.join(self.src_dir, "doc.pdf")
        create_dummy_pdf(doc1, "c1 source")
        clash = os.path.join(out_dir, "c1_doc.bundle_stamped.pdf")
        create_dummy_pdf(clash, "ebook source")
        docs = dict(self.docs, c1=doc1, ebook=clash)
        before = _file_digest(clash)
        manifest = os.path.join(out_dir, "bundle_manifest.json")
        with self.assertRaisesRegex(ValueError, "source document ebook"):
            self._bundle(output_manifest=manifest, output_dir=out_dir, stamp=True, docs=docs)
        self.assertEqual(_file_digest(clash), before)
        self.assertFalse(os.path.exists(manifest), "no manifest may be written for a refused call")

    def test_manifest_path_equal_to_a_stamped_output_is_refused(self):
        out_dir = os.path.join(self.tmp, "out")
        os.makedirs(out_dir)
        doc1 = os.path.join(self.src_dir, "doc.pdf")
        create_dummy_pdf(doc1, "c1 source")
        docs = dict(self.docs, c1=doc1)
        with self.assertRaisesRegex(ValueError, "both name"):
            self._bundle(output_manifest=os.path.join(out_dir, "c1_doc.bundle_stamped.pdf"),
                         output_dir=out_dir, stamp=True, docs=docs)

    def test_cli_refuses_a_manifest_path_that_is_a_source_with_exit_2(self):
        before = _file_digest(self.docs["c2"])
        env = dict(os.environ, ASSET_SALT=TEST_SALT)
        res = subprocess.run(
            [sys.executable, MANIFEST_SCRIPT, "--c1-doc", self.docs["c1"], "--c2-doc", self.docs["c2"],
             "--c3-doc", self.docs["c3"], "--ebook-doc", self.docs["ebook"], "--creator-id", "example-creator",
             "--creator-name", "the owner", "--product-id", "sample-product", "--output-manifest", self.docs["c2"]],
            capture_output=True, text=True, env=env,
        )
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertIn("source document c2", res.stderr)
        self.assertEqual(_file_digest(self.docs["c2"]), before)


class TestSiteCheckRoutes(unittest.TestCase):
    """live_site_check.py must check the product page and the creator hub, and derive the hub from the handle."""

    def _load_with_config(self, site_slug):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "payments"))
        with open(os.path.join(tmp, "payments", "config.duane.json"), "w", encoding="utf-8") as f:
            json.dump({"site_slug": site_slug, "price_usd": 1, "title": "t", "checkout_mode": "gated"}, f)
        from pathlib import Path
        fake_book_config = types.ModuleType("book_config")  # live_site_check imports REPO and QA from it
        fake_book_config.REPO = Path(tmp)
        fake_book_config.QA = Path(tmp) / "qa"
        spec = importlib.util.spec_from_file_location(
            "live_site_check", os.path.join(REPO_ROOT, "scripts", "live_site_check.py"))
        module = importlib.util.module_from_spec(spec)
        with unittest.mock.patch.dict(sys.modules, {"book_config": fake_book_config}):
            spec.loader.exec_module(module)
        return module

    def test_pages_are_the_home_page_the_product_page_and_the_creator_hub(self):
        mod = self._load_with_config("example-creator/sample-book")
        self.assertEqual(mod.PAGES, ("/", "/books/example-creator/sample-book/", "/books/example-creator/"))
        self.assertEqual(mod.CREATOR_HUB, "/books/example-creator/")

    def test_hub_is_not_the_product_page(self):
        mod = self._load_with_config("example-creator/sample-book")
        self.assertNotEqual(mod.CREATOR_HUB, mod.PRODUCT_PAGE)


if __name__ == "__main__":
    unittest.main()
