"""Tests for scripts/preview_pdf_build.py empty/missing page spec rejection (PR #138 P1-a).

Run: python3 -m unittest scripts/__tests__/test_preview_pdf_build.py -v
"""
import importlib
import io
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
import unittest.mock as mock

REPO = Path(__file__).resolve().parent.parent.parent


def _load_preview_pdf_build():
    scripts_dir = str(REPO / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    return importlib.import_module("preview_pdf_build")


preview_pdf_build = _load_preview_pdf_build()


class PreviewPdfBuildSpecTests(unittest.TestCase):
    def test_build_preview_pdf_rejects_empty_and_missing_specs_before_opening_pdf(self):
        fake_pdf = Path("/nonexistent/should_not_be_opened.pdf")
        fake_out = Path("/nonexistent/out_preview.pdf")

        # Fail before importing pdfplumber/pikepdf or calling parse_pages.
        for bad_spec in ("", "   ", "\t\n", None):
            with self.subTest(spec=bad_spec):
                with mock.patch.dict(sys.modules, {"pdfplumber": None, "pikepdf": None}):
                    with self.assertRaises(ValueError):
                        preview_pdf_build.build_preview_pdf(fake_pdf, bad_spec, fake_out)  # type: ignore[arg-type]

    def test_main_exits_nonzero_when_book_config_lacks_preview_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_pdf = Path(tmp) / "full.pdf"
            source_pdf.write_bytes(b"%PDF-1.4\n")
            out_pdf = Path(tmp) / "preview.pdf"
            cfg_without_pages = {"id": "no_pages_book", "preview_pdf": "/books/previews/x.pdf"}

            with mock.patch.object(preview_pdf_build, "load_book_cfg", return_value=cfg_without_pages), \
                    mock.patch.object(
                        sys,
                        "argv",
                        ["preview_pdf_build.py", "--source", str(source_pdf), "--out-pdf", str(out_pdf)],
                    ), \
                    mock.patch.object(preview_pdf_build, "build_preview_pdf") as build_mock:
                with self.assertRaises(SystemExit) as ctx:
                    preview_pdf_build.main()
                self.assertNotEqual(ctx.exception.code, 0)
                build_mock.assert_not_called()
                self.assertFalse(out_pdf.exists())

    def test_main_exits_nonzero_when_pages_flag_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_pdf = Path(tmp) / "full.pdf"
            source_pdf.write_bytes(b"%PDF-1.4\n")
            out_pdf = Path(tmp) / "preview.pdf"
            cfg_with_pages = {"id": "duane", "preview_pages": "1,3,5"}

            for flag_val in ("", "   "):
                with self.subTest(pages=flag_val):
                    with mock.patch.object(preview_pdf_build, "load_book_cfg", return_value=cfg_with_pages), \
                            mock.patch.object(
                                sys,
                                "argv",
                                [
                                    "preview_pdf_build.py",
                                    "--source",
                                    str(source_pdf),
                                    "--pages",
                                    flag_val,
                                    "--out-pdf",
                                    str(out_pdf),
                                ],
                            ), \
                            mock.patch.object(preview_pdf_build, "build_preview_pdf") as build_mock:
                        with self.assertRaises(SystemExit) as ctx:
                            preview_pdf_build.main()
                        self.assertNotEqual(ctx.exception.code, 0)
                        build_mock.assert_not_called()
                        self.assertFalse(out_pdf.exists())

    def test_cli_subprocess_rejects_empty_pages_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_pdf = Path(tmp) / "full.pdf"
            source_pdf.write_bytes(b"%PDF-1.4\n")
            out_pdf = Path(tmp) / "preview.pdf"
            env = dict(os.environ, BOOK="duane")
            proc = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "scripts" / "preview_pdf_build.py"),
                    "--source",
                    str(source_pdf),
                    "--pages",
                    "",
                    "--out-pdf",
                    str(out_pdf),
                ],
                cwd=str(REPO),
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("Missing or empty preview page spec", proc.stderr)
            self.assertFalse(out_pdf.exists())

    def test_build_preview_pdf_extracts_only_requested_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_pdf = Path(tmp) / "full.pdf"
            source_pdf.write_bytes(b"%PDF-1.4\n")
            out_pdf = Path(tmp) / "out" / "preview.pdf"

            appended_pages: list[int] = []

            class FakePdfContext:
                def __init__(self, count: int) -> None:
                    self.pages = [f"page-{i}" for i in range(1, count + 1)]

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

            class FakePikePdf:
                def __init__(self) -> None:
                    self.pages = [1, 2, 3, 4, 5]

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

            class FakeDstPdf:
                def __init__(self) -> None:
                    self.pages = self

                def append(self, page: int) -> None:
                    appended_pages.append(page)

                def save(self, path: Path) -> None:
                    Path(path).write_bytes(b"%PDF-1.4\n")

            fake_pdfplumber = types.SimpleNamespace(
                open=lambda p: FakePdfContext(2 if Path(p) == out_pdf else 5),
            )
            fake_pikepdf = types.SimpleNamespace(
                open=lambda _p: FakePikePdf(),
                Pdf=types.SimpleNamespace(new=lambda: FakeDstPdf()),
            )

            def fake_gs(cmd: list[str], check: bool = False) -> subprocess.CompletedProcess[str]:
                for arg in cmd:
                    if arg.startswith("-sOutputFile="):
                        Path(arg.split("=", 1)[1]).write_bytes(b"%PDF-1.7\n")
                return subprocess.CompletedProcess(cmd, 0)

            with mock.patch.dict(sys.modules, {"pdfplumber": fake_pdfplumber, "pikepdf": fake_pikepdf}), \
                    mock.patch.object(preview_pdf_build.shutil, "which", return_value="/usr/bin/gs"), \
                    mock.patch.object(preview_pdf_build.subprocess, "run", side_effect=fake_gs), \
                    mock.patch("sys.stdout", new_callable=io.StringIO):
                count = preview_pdf_build.build_preview_pdf(source_pdf, "1,3", out_pdf)

            self.assertEqual(count, 2)
            self.assertEqual(appended_pages, [1, 3])
            self.assertTrue(out_pdf.exists())


if __name__ == "__main__":
    unittest.main()
