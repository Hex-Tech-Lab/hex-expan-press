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

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import pypdf

os.environ.setdefault("ASSET_SALT", "test-only-salt")

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
            "--creator-id", "retirearly500k",
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
        self.assertEqual(manifest["creator"]["id"], "retirearly500k")
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
            "--creator-id", "retirearly500k",
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
            "--creator-id", "retirearly500k",
            "--creator-name", "the owner",
            "--product-id", "500k-playbook",
            "--output-manifest", manifest2_path
        ]
        subprocess.run(cmd2, check=True)
        with open(manifest2_path) as f:
            sig2 = json.load(f)["bundle_root_signature"]

        self.assertNotEqual(sig1, sig2, "Tampered artifact failed to alter root bundle signature!")



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

    def test_manifest_refuses_to_sign_without_salt(self):
        res = self._run_without_salt(MANIFEST_SCRIPT, ["--help"])
        self.assertEqual(res.returncode, 0, "--help must not need the salt")
        with tempfile.TemporaryDirectory() as tmp:
            dummy = os.path.join(tmp, "x.pdf")
            create_dummy_pdf(dummy)
            res = self._run_without_salt(WATERMARK_SCRIPT, ["--input", dummy, "--output", os.path.join(tmp, "o.pdf"), "--mode", "perimeter", "--creator-id", "c", "--creator-name", "n", "--purpose", "review"])
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("ASSET_SALT is not set", res.stderr)


if __name__ == "__main__":
    unittest.main()
