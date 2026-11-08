#!/usr/bin/env python3
"""Commit guard (T37-W1c, I8+I9): pre-commit gate over STAGED changes only.

Reads `git diff --cached` (read-only git) or a synthetic diff via --diff-file (for testing).
Deterministic layer (any hit sets a BLOCK verdict; the remaining files are still checked):
  - key-like strings: sk-..., Bearer <token>, AKIA..., 32+ char hex/base64 on a line near key/token/secret
  - .env content: added lines that are dotenv-style assignments for secret-ish variable names
  - forbidden paths: any added file under data/, adr/, manuscript/book/, docs/history/ (Rule #0)
Jev layer on added TEXT hunks (<=60 lines each): two noul questions per hunk:
  business_sensitive - pricing strategy, revenue split, contract terms, council decisions,
                       creator financial details, legal strategy
  secret_like        - looks like a credential, key or secret
Bands: p >= 0.8 -> BLOCK (exit 1), 0.5-0.8 -> FLAG (printed, exit 0), < 0.5 -> PASS.
Jev unavailable -> BLOCK unless COMMIT_GUARD_ALLOW_UNCHECKED=1; --no-jev -> UNCHECKED (deterministic checks only).

Usage: python3 scripts/commit_guard.py [--diff-file <path>] [--no-jev]
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jev import decide  # noqa: E402

LO, HI = 0.5, 0.8
FORBIDDEN_DIRS = ("data/", "adr/", "manuscript/book/", "docs/history/", "typst_prototype/img_v3/")
QUESTIONS = {
    "business_sensitive": {"type": "noul",
        "instructions": "Does this diff hunk expose business-sensitive material: pricing strategy, revenue split, "
                        "contract terms, council decisions, creator financial details, or legal strategy?",
        "criteria": {"true": "It contains such business-sensitive details.", "false": "It does not."}},
    "secret_like": {"type": "noul",
        "instructions": "Does this diff hunk look like it contains a credential, API key, token, password or secret?",
        "criteria": {"true": "It contains something secret-like.", "false": "It does not."}},
}
# Deterministic key-like patterns.
DETERMINISTIC = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)\b(?:key|token|secret)\b[^\n]{0,40}[A-Za-z0-9+/]{32,}\b"),
    re.compile(r"(?i)^[A-Za-z0-9_+/]{32,}$"),
]
# .env-style secret assignments (e.g. OPENROUTER_API_KEY=sk-...).
ENV_ASSIGN = re.compile(r"(?im)^[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\s*=")


def _chunks(lines):
    """Split added lines into Jev-sized chunks. Every line reaches the checks; none is dropped."""
    return [lines[i:i + 60] for i in range(0, len(lines), 60)]


def hunks(diff_text):
    """[(file, [added lines])] grouped per file, each hunk split into chunks of at most 60 lines.

    A `+++ ` line is a file header only directly after a `--- ` line in the header block of a `diff --git`.
    Supports standard git diffs and combined merge diffs (diff --cc / diff --combined).
    An added line whose content starts with `++` (diff line `+++...`) is content and is kept, so it reaches the checks.
    """
    out, cur_file, cur_adds = [], None, []
    in_header = False
    prefix_len = 1

    def flush():
        if cur_file and cur_adds:
            out.extend((cur_file, c) for c in _chunks(cur_adds))

    for line in diff_text.splitlines():
        if line.startswith("diff --"):
            flush()
            cur_file, cur_adds, in_header = None, [], True
            prefix_len = 1
            parts = line.split()
            if len(parts) >= 3 and parts[1] in ("--cc", "--combined"):
                cur_file = parts[2]
        elif in_header and line.startswith("--- "):
            continue  # old-file header, never content
        elif in_header and line.startswith("+++ "):
            in_header = False
            if line.startswith("+++ /dev/null"):
                cur_file = "/dev/null"
            elif line.startswith("+++ b/"):
                cur_file = line[6:]
        elif line.startswith("@@"):
            flush()
            cur_adds, in_header = [], False
            lead_at = len(line) - len(line.lstrip("@"))
            prefix_len = max(1, lead_at - 1)
        elif len(line) >= prefix_len and line[:prefix_len].count("+") > 0:
            cur_adds.append(line[prefix_len:])
        elif len(line) >= prefix_len and line[:prefix_len].count("-") > 0:
            flush()
            cur_adds = []
    flush()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--diff-file")
    ap.add_argument("--no-jev", action="store_true")
    args = ap.parse_args()
    if args.diff_file:
        diff = Path(args.diff_file).read_text(encoding="utf-8", errors="replace")
    else:
        diff = subprocess.run(["git", "diff", "--cached"], capture_output=True, text=True, errors="replace").stdout

    worst, flags = 0, []
    # binary files (images) have no "+++ b/" line, so take staged names from git itself as well
    paths = set(re.findall(r"^\+\+\+ b/(.+)$", diff, re.M))
    paths |= set(re.findall(r"^diff --(?:cc|combined) (.+)$", diff, re.M))
    paths |= set(re.findall(r"^Binary files .* and b/(.+) differ$", diff, re.M))
    if not args.diff_file:
        # --diff-filter=d: deletions are allowed (untracking a forbidden file is the fix, not a leak)
        paths |= set(subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=d", "-z"],
                                    capture_output=True, text=True).stdout.split("\0")) - {""}
    for path in sorted(paths):
        if any(path == d.rstrip("/") or path.startswith(d) for d in FORBIDDEN_DIRS):
            print(f"BLOCK: forbidden path staged: {path}")
            worst = 1
    for fname, adds in hunks(diff):
        blob = "\n".join(adds)
        base = fname.rsplit("/", 1)[-1]
        if (base.startswith(".env") and base != ".env.example") or ENV_ASSIGN.search(blob):
            print(f"BLOCK: .env / secret assignment content in {fname}")
            worst = 1
            continue
        for line in adds:
            if any(rx.search(line) for rx in DETERMINISTIC):
                print(f"BLOCK: key-like string in {fname}: {line[:80]}")
                worst = 1
                break
        else:
            if args.no_jev:
                flags.append((fname, None, "UNCHECKED (Jev off)"))
                continue
            a = decide({"file": fname, "hunk": blob}, QUESTIONS, timeout=20)
            if (
                not isinstance(a, dict)
                or not isinstance(a.get("business_sensitive"), dict)
                or not isinstance(a.get("secret_like"), dict)
                or "noul" not in a["business_sensitive"]
                or "noul" not in a["secret_like"]
            ):
                # Fail closed: a hunk Jev did not classify or returned malformed is not a pass. Overridden only by an explicit env var.
                flags.append((fname, None, "UNCHECKED (Jev unavailable)"))
                continue
            p = max(a["business_sensitive"]["noul"], a["secret_like"]["noul"])
            if p >= HI:
                print(f"BLOCK: Jev p={p:.2f} on {fname}")
                worst = 1
            elif p >= LO:
                flags.append((fname, p, "FLAG"))
            else:
                flags.append((fname, p, "PASS"))
    for fname, p, v in flags:
        print(f"{v}{'' if p is None else f' (p={p:.2f})'}: {fname}")
    checked = sum(1 for _, p, _ in flags if p is not None)
    unavailable = sum(1 for _, _, v in flags if v == "UNCHECKED (Jev unavailable)")
    if unavailable:
        if os.environ.get("COMMIT_GUARD_ALLOW_UNCHECKED") == "1":
            print(f"WARNING: {unavailable} hunk(s) NOT checked by Jev. COMMIT_GUARD_ALLOW_UNCHECKED=1 lets them through.")
        else:
            print(f"BLOCK: {unavailable} hunk(s) NOT checked by Jev (unavailable). Retry, or set COMMIT_GUARD_ALLOW_UNCHECKED=1 to override.")
            worst = 1
    if args.no_jev:
        verdict = "BLOCK" if worst else "CLEAR"
        print(f"COMMIT-GUARD: {verdict} (deterministic checks only: --no-jev)")
    else:
        verdict = "BLOCK" if worst else ("CLEAR-WITH-UNCHECKED" if unavailable else "CLEAR")
        print(f"COMMIT-GUARD: {verdict} (checked {checked}, unchecked {unavailable})")
    sys.exit(worst)


if __name__ == "__main__":
    main()
