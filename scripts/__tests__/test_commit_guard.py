"""Tests for scripts/commit_guard.py and the scripts/jev.py client it gates on.

Run: python3 -m unittest discover -s scripts/__tests__ -p 'test_*.py'   (pytest is not installed here)
Jev is never called over the network: commit_guard.decide / urllib are patched.
"""
import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import commit_guard  # noqa: E402
import jev  # noqa: E402

CLEAN = {"business_sensitive": {"noul": 0.0}, "secret_like": {"noul": 0.0}}
LEAKY = "sk-" + "a1B2c3D4e5" * 3  # 33 chars, matches the sk- pattern


def diff_adding(lines, path="docs/notes.md"):
    body = "\n".join("+" + line for line in lines)
    return f"diff --git a/{path} b/{path}\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{len(lines)} @@\n{body}\n"


def run_guard(diff, *, decide_result, env=None, extra_args=()):
    """Run commit_guard.main() on a synthetic diff. Returns (exit_code, stdout, decide_mock)."""
    with tempfile.TemporaryDirectory() as tmp:
        diff_file = Path(tmp) / "d.diff"
        diff_file.write_text(diff)
        out = io.StringIO()
        env_patch = dict(env or {})
        with mock.patch.dict(os.environ, env_patch), \
                mock.patch.object(commit_guard, "decide", return_value=decide_result) as decide, \
                mock.patch.object(sys, "argv", ["commit_guard.py", "--diff-file", str(diff_file), *extra_args]), \
                contextlib.redirect_stdout(out):
            if "COMMIT_GUARD_ALLOW_UNCHECKED" not in env_patch:
                os.environ.pop("COMMIT_GUARD_ALLOW_UNCHECKED", None)
            try:
                commit_guard.main()
            except SystemExit as exc:
                return exc.code, out.getvalue(), decide
        raise AssertionError("commit_guard.main() did not exit")


class ChunkingTests(unittest.TestCase):
    def test_hunk_over_60_lines_is_split_and_no_line_is_dropped(self):
        lines = [f"line {i}" for i in range(1, 131)]
        chunks = commit_guard.hunks(diff_adding(lines))
        self.assertEqual([len(c) for _, c in chunks], [60, 60, 10])
        self.assertEqual([x for _, c in chunks for x in c], lines)

    def test_secret_on_line_70_of_a_long_hunk_is_caught(self):
        lines = [f"harmless line {i}" for i in range(1, 81)]
        lines[69] = f"api = '{LEAKY}'"  # line 70, beyond the first 60-line chunk
        code, out, _ = run_guard(diff_adding(lines), decide_result=CLEAN)
        self.assertEqual(code, 1)
        self.assertIn("BLOCK: key-like string in docs/notes.md", out)

    def test_long_clean_hunk_is_fully_scanned_and_clears(self):
        lines = [f"harmless line {i}" for i in range(1, 131)]
        code, out, decide = run_guard(diff_adding(lines), decide_result=CLEAN)
        self.assertEqual(code, 0)
        self.assertEqual(decide.call_count, 3)  # one Jev question per 60-line chunk
        self.assertIn("COMMIT-GUARD: CLEAR (checked 3, unchecked 0)", out)


class UnclassifiedHunkTests(unittest.TestCase):
    def test_hunk_jev_could_not_classify_fails_the_commit(self):
        code, out, _ = run_guard(diff_adding(["a harmless sentence"]), decide_result=None)
        self.assertEqual(code, 1)
        self.assertIn("BLOCK: 1 hunk(s) NOT checked by Jev (unavailable)", out)
        self.assertIn("COMMIT-GUARD: BLOCK", out)

    def test_allow_unchecked_override_lets_it_through_and_logs(self):
        code, out, _ = run_guard(diff_adding(["a harmless sentence"]), decide_result=None,
                                 env={"COMMIT_GUARD_ALLOW_UNCHECKED": "1"})
        self.assertEqual(code, 0)
        self.assertIn("WARNING: 1 hunk(s) NOT checked by Jev. COMMIT_GUARD_ALLOW_UNCHECKED=1 lets them through.", out)
        self.assertIn("COMMIT-GUARD: CLEAR-WITH-UNCHECKED (checked 0, unchecked 1)", out)

    def test_allow_unchecked_does_not_override_a_deterministic_block(self):
        code, out, _ = run_guard(diff_adding([f"curl with {LEAKY}"]), decide_result=None,
                                 env={"COMMIT_GUARD_ALLOW_UNCHECKED": "1"})
        self.assertEqual(code, 1)
        self.assertIn("BLOCK: key-like string", out)

    def test_override_value_other_than_1_is_ignored(self):
        code, _, _ = run_guard(diff_adding(["a harmless sentence"]), decide_result=None,
                               env={"COMMIT_GUARD_ALLOW_UNCHECKED": "true"})
        self.assertEqual(code, 1)


class JevClientTests(unittest.TestCase):
    def test_no_api_key_returns_none_and_logs(self):
        err = io.StringIO()
        with mock.patch.object(jev, "_key", return_value=None), contextlib.redirect_stderr(err):
            self.assertIsNone(jev.decide("x", {}))
        self.assertIn("no OPENROUTER_API_KEY", err.getvalue())

    def test_transport_failure_returns_none_and_logs_the_reason(self):
        err = io.StringIO()
        with mock.patch.object(jev, "_key", return_value="k"), \
                mock.patch.object(jev.urllib.request, "urlopen", side_effect=TimeoutError("slow")), \
                contextlib.redirect_stderr(err):
            self.assertIsNone(jev.decide("x", {}))
        self.assertIn("jev: call failed: TimeoutError", err.getvalue())

    def test_success_returns_the_answers_dict(self):
        resp = io.BytesIO(b'{"answers": {"q": {"noul": 0.1}}}')
        with mock.patch.object(jev, "_key", return_value="k"), \
                mock.patch.object(jev.urllib.request, "urlopen", return_value=resp):
            self.assertEqual(jev.decide("x", {}), {"q": {"noul": 0.1}})


if __name__ == "__main__":
    unittest.main()
