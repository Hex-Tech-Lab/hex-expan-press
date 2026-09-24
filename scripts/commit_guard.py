#!/usr/bin/env python3
"""Commit guard (T37-W1c, I8+I9): pre-commit gate over STAGED changes only.

Reads `git diff --cached` (read-only git) or a synthetic diff via --diff-file (for testing).
Deterministic layer (exit 1 immediately on any hit):
  - key-like strings: sk-..., Bearer <token>, AKIA..., 32+ char hex/base64 on a line near key/token/secret
  - .env content: added lines that are dotenv-style assignments for secret-ish variable names
  - forbidden paths: any added file under data/, adr/, manuscript/book/, docs/history/ (Rule #0)
Jev layer on added TEXT hunks (<=60 lines each): two noul questions per hunk:
  business_sensitive - pricing strategy, revenue split, contract terms, council decisions,
                       creator financial details, legal strategy
  secret_like        - looks like a credential, key or secret
Bands: p >= 0.8 -> BLOCK (exit 1), 0.5-0.8 -> FLAG (printed, exit 0), < 0.5 -> PASS.
Jev down / --no-jev -> UNCHECKED.

Usage: python3 scripts/commit_guard.py [--diff-file <path>] [--no-jev]
"""
import argparse
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


def hunks(diff_text):
    """[(file, [added lines])] grouped per file, added text hunks capped at 60 lines each."""
    out, cur_file, cur_adds = [], None, []
    for line in diff_text.splitlines():
        if line.startswith("+++ b/"):
            cur_file = line[6:]
        elif line.startswith("+++ /dev/null"):
            cur_file = "/dev/null"
        elif line.startswith("+") and not line.startswith("+++"):
            cur_adds.append(line[1:])
        elif line.startswith(("diff --git", "@@")) or line.startswith("-") and not line.startswith("---"):
            if cur_file and cur_adds:
                out.append((cur_file, cur_adds[:60]))
            if line.startswith("diff --git") or line.startswith("@@"):
                cur_adds = []
            else:
                cur_adds = []
    if cur_file and cur_adds:
        out.append((cur_file, cur_adds[:60]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--diff-file")
    ap.add_argument("--no-jev", action="store_true")
    args = ap.parse_args()
    if args.diff_file:
        diff = Path(args.diff_file).read_text()
    else:
        diff = subprocess.run(["git", "diff", "--cached"], capture_output=True, text=True).stdout

    worst, flags = 0, []
    # binary files (images) have no "+++ b/" line, so take staged names from git itself as well
    paths = set(re.findall(r"^\+\+\+ b/(.+)$", diff, re.M))
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
        if fname.endswith(".env") or ENV_ASSIGN.search(blob):
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
            if a is None:
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
    print(f"COMMIT-GUARD: {'BLOCK' if worst else 'CLEAR'} ({len(flags)} Jev-checked hunks)")
    sys.exit(worst)


if __name__ == "__main__":
    main()
