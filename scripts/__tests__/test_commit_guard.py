"""Tests for scripts/commit_guard.py diff parsing (run: python3 -m unittest discover -s scripts/__tests__)."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
GUARD = SCRIPTS / "commit_guard.py"
sys.path.insert(0, str(SCRIPTS))
import commit_guard  # noqa: E402

# Built at runtime so this file itself never contains a key-shaped literal (the guard scans it too).
SAMPLE = "sk" + "-" + "FAKE" * 6 + "1234"


def run_guard(diff_text):
    with tempfile.NamedTemporaryFile("w", suffix=".diff", delete=False) as f:
        f.write(diff_text)
    try:
        return subprocess.run([sys.executable, str(GUARD), "--diff-file", f.name, "--no-jev"],
                              capture_output=True, text=True)
    finally:
        Path(f.name).unlink()


class PlusPlusContentLine(unittest.TestCase):
    def test_added_line_starting_with_plus_plus_is_scanned(self):
        diff = ("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,1 +1,2 @@\n ctx\n"
                f"+++ token = {SAMPLE}\n")
        r = run_guard(diff)
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("BLOCK: key-like string in x.py", r.stdout)

    def test_added_line_starting_with_plus_plus_plus_b_is_content(self):
        # A content line shaped like a header must not rename the file or hide the secret.
        diff = ("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,0 +1,2 @@\n"
                "+++ b/other.py\n"
                f"+key = {SAMPLE}\n")
        self.assertEqual(commit_guard.hunks(diff), [("x.py", ["++ b/other.py", f"key = {SAMPLE}"])])
        self.assertEqual(run_guard(diff).returncode, 1)

    def test_removed_dash_dash_then_added_plus_plus_inside_hunk_is_content(self):
        diff = ("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,1 +1,1 @@\n"
                "--- old\n"
                f"+++ token = {SAMPLE}\n")
        self.assertEqual(run_guard(diff).returncode, 1)


class RealFileHeader(unittest.TestCase):
    def test_file_header_is_not_content(self):
        diff = ("diff --git a/some/file.py b/some/file.py\n--- a/some/file.py\n+++ b/some/file.py\n"
                "@@ -1,1 +1,2 @@\n ctx\n+print('hi')\n")
        self.assertEqual(commit_guard.hunks(diff), [("some/file.py", ["print('hi')"])])
        r = run_guard(diff)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("CLEAR", r.stdout)

    def test_new_and_deleted_file_headers(self):
        diff = ("diff --git a/a.py b/a.py\nnew file mode 100644\n--- /dev/null\n+++ b/a.py\n@@ -0,0 +1 @@\n+x = 1\n"
                "diff --git a/b.py b/b.py\ndeleted file mode 100644\n--- a/b.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-y = 2\n")
        self.assertEqual(commit_guard.hunks(diff), [("a.py", ["x = 1"])])

    def test_two_files_attribute_lines_to_the_right_file(self):
        diff = ("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,0 +1,1 @@\n+one\n"
                "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1,0 +1,1 @@\n+two\n")
        self.assertEqual(commit_guard.hunks(diff), [("a.py", ["one"]), ("b.py", ["two"])])

    def test_header_shaped_content_does_not_add_forbidden_path_false_negative(self):
        # A real forbidden-path header still blocks.
        diff = ("diff --git a/data/x.json b/data/x.json\n--- /dev/null\n+++ b/data/x.json\n"
                "@@ -0,0 +1 @@\n+{}\n")
        self.assertEqual(run_guard(diff).returncode, 1)


if __name__ == "__main__":
    unittest.main()
