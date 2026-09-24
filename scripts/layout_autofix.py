#!/usr/bin/env python3
"""Deterministic manuscript fixer driven by autofix_triage.json (stdlib only)."""
import argparse, difflib, json, os, re, shutil, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from book_config import MS, QA


def ws_tolerant(before: str) -> re.Pattern:
    return re.compile(r"\s*".join(re.escape(tok) for tok in before.split()))


def double_space_pass(text: str):
    out_lines, count, in_fence = [], 0, False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out_lines.append(line)
            continue
        if in_fence or not line or line[0] in " \t#`":
            out_lines.append(line)
            continue
        def repl(m):
            nonlocal count
            count += 1
            return " "
        new = re.sub(r"(?<=\S) {2,}(?=\S)", repl, line)
        out_lines.append(new)
    return "\n".join(out_lines), count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--triage", default=os.path.join(QA, "autofix_triage.json"))
    ap.add_argument("--manuscript", default=str(MS))
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    with open(args.triage) as f:
        triage = json.load(f)
    items = [it for it in triage.get("items", [])
             if it.get("class") == "MECHANICAL" and (it.get("before") or "").strip()]
    with open(args.manuscript) as f:
        original = f.read()

    text, results = original, []
    for it in items:
        pat = ws_tolerant(it["before"])
        matches = list(pat.finditer(text))
        if len(matches) == 1:
            m = matches[0]
            text = text[:m.start()] + it["after"] + text[m.end():]
            results.append((it, "APPLIED", ""))
        elif not matches:
            results.append((it, "SKIPPED", "no match"))
        else:
            results.append((it, "SKIPPED", f"ambiguous ({len(matches)})"))

    text, ds_count = double_space_pass(text)

    diff = list(difflib.unified_diff(original.splitlines(keepends=True),
                                     text.splitlines(keepends=True),
                                     fromfile="manuscript_original", tofile="manuscript_autofixed"))
    summary_lines = ["| item | status | reason |", "|---|---|---|"]
    for i, (it, status, reason) in enumerate(results):
        label = it["before"][:40].replace("|", "\\|")
        summary_lines.append(f"| {i+1} `{label}` | {status} | {reason or '-'} |")
    summary_lines.append(f"| double-space pass | APPLIED | {ds_count} change(s) |")
    summary = "\n".join(summary_lines)

    if args.dry_run:
        print("".join(diff) if diff else "(no diff)")
        print()
        print(summary)
    else:
        stamp = datetime.now().strftime("%Y%m%d_%H%M")
        rev_dir = os.path.join(QA, "revisions")
        os.makedirs(rev_dir, exist_ok=True)
        backup = os.path.join(rev_dir, f"manuscript_before_autofix_{stamp}.md")
        shutil.copy2(args.manuscript, backup)
        with open(args.manuscript, "w") as f:
            f.write(text)
        print(f"backup: {backup}")
        print(summary)

    with open(os.path.join(QA, "autofix_report.md"), "w") as f:
        f.write("# layout_autofix report\n\nMode: " +
                ("dry-run" if args.dry_run else "apply") +
                f"\nManuscript: {args.manuscript}\n\n" + summary + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
