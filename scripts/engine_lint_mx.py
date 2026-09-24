#!/usr/bin/env python3
"""Process-lesson lint (T35-K3): turns the DOCUMENTED-ONLY process lessons into checked rules.

Scans scripts/ and docs/agent-prompts/ for forbidden patterns:
  X-01  `pgrep -f` / `pkill -f` with a pattern that could match your own command (self-kill risk)
  X-02  `opencode run` without `--variant minimal`; `/tmp` usage (in-repo scratch only —
        negated mentions like "never /tmp" in prompts are fine)
  X-13  `rm -rf` in scripts (never move/delete existing data to test fallbacks)
  X-11  hard-coded secret-looking strings (`sk-...`) outside .env reads

Prints a `| lesson | check | PASS/FAIL |` table; exit 1 on any FAIL.
"""
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "scripts"
PROMPTS = REPO / "docs/agent-prompts"


def scan(root: Path, pattern: str, negated=None, suffixes=(".py", ".sh", ".md", ".ts")):
    """[(file, line_no, line)] for lines matching `pattern`, skipping negated lines (lesson rules that
    mention the forbidden pattern in order to forbid it, e.g. 'never /tmp')."""
    out = []
    if not root.exists():
        return out
    for f in sorted(root.rglob("*")):
        if f.suffix not in suffixes or not f.is_file():
            continue
        if f.relative_to(REPO).as_posix() == "scripts/engine_lint_mx.py":  # this lint's own rules/docs
            continue
        for i, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            if "lint-allow:" in line:  # explicit, documented exception on the same line
                continue
            if not re.search(pattern, line):
                continue
            if negated and re.search(negated, line):
                continue
            out.append((f.relative_to(REPO), i, line.strip()[:120]))
    return out


def main():
    # X-02: opencode run without --variant minimal, across scripts + prompts
    oc = []
    for base in (SCRIPTS, PROMPTS):
        oc += scan(base, r"\bopencode run\b", negated=r"--variant\s+minimal")
    checks = [
        ("X-01", "pgrep/pkill -f in scripts",
         scan(SCRIPTS, r"\b(pgrep|pkill)\s+-f\b")),
        ("X-02", "opencode run without --variant minimal", oc),
        ("X-02", "/tmp in scripts",
         scan(SCRIPTS, r"/tmp(?![\w-])")),
        ("X-02", "/tmp in prompts (non-negated)",
         scan(PROMPTS, r"/tmp(?![\w-])", negated=r"(?i)never|`/tmp`|auto-rejected")),
        ("X-13", "rm -rf in scripts",
         scan(SCRIPTS, r"\brm\s+-rf\b", negated=r"(mktemp|\btrap\b)")),  # deleting its own mktemp workdir is fine
        ("X-11", "hard-coded sk- secrets",
         scan(SCRIPTS, r"sk-[A-Za-z0-9_-]{20,}")),
    ]

    rows, fails = [], []
    for lesson, check, hits in checks:
        status = "PASS" if not hits else "FAIL"
        rows.append((lesson, check, status, hits))
        if hits:
            fails.append((lesson, check, hits))
    print("| lesson | check | PASS/FAIL |")
    print("|---|---|---|")
    for lesson, check, status, _ in rows:
        print(f"| {lesson} | {check} | {status} |")
    if fails:
        print("\nDetails:")
        for lesson, check, hits in fails:
            for f, ln, line in hits[:6]:
                print(f"  {lesson} [{check}] {f}:{ln}: {line}")
            if len(hits) > 6:
                print(f"  {lesson} [{check}] ... +{len(hits) - 6} more")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
