#!/usr/bin/env python3
"""Deterministic manuscript fixer driven by autofix_triage.json (stdlib only)."""
import argparse, difflib, json, os, re, shutil, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from book_config import MS, QA
from jev import decide  # noqa: E402

CTX_CHARS, HI, LO = 80, 0.8, 0.5


def jev_target(text, item, matches):
    """Ask Jev which occurrence (or none) is the intended edit target.
    Returns (match_or_None, top_p) or (None, None) when Jev is down."""
    ctxs, names = [], []
    for k, m in enumerate(matches, 1):
        a = max(0, m.start() - CTX_CHARS)
        b = min(len(text), m.end() + CTX_CHARS)
        ctxs.append(re.sub(r"\s+", " ", text[a:b]))
        names.append(f"match_{k}")
    crit = {n: "this occurrence is the intended target for this edit" for n in names}
    crit["none"] = "no listed occurrence is the intended target; the edit must not be applied"
    ans = decide({"before": item["before"], "after": item["after"], "matches": ctxs},
                 {"target": {"type": "choice",
                             "instructions": "Which occurrence is the intended target to replace with the after text?",
                             "criteria": crit}})
    if ans is None:
        return None, None
    tgt = ans.get("target") or {}
    pick = tgt.get("choice")
    probs = tgt.get("probabilities") or {}
    top_p = max(probs.values()) if probs else 0.0
    if pick in names:
        return matches[names.index(pick)], top_p
    return None, top_p


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
    ap.add_argument("--no-jev", action="store_true")
    args = ap.parse_args()

    with open(args.triage) as f:
        triage = json.load(f)
    items = [it for it in triage.get("items", [])
             if it.get("class") == "MECHANICAL" and (it.get("before") or "").strip()]
    with open(args.manuscript) as f:
        original = f.read()

    text, results = original, []
    use_jev = "--no-jev" not in sys.argv
    for it in items:
        pat = ws_tolerant(it["before"])
        matches = list(pat.finditer(text))
        if len(matches) == 1:
            m = matches[0]
            text = text[:m.start()] + it["after"] + text[m.end():]
            results.append((it, "APPLIED", ""))
        elif not matches:
            if use_jev:
                _, p = jev_target(text, it, [])
                if p is not None:
                    if p >= LO:
                        flag = " FLAG" if p < HI else ""
                        results.append((it, "SKIPPED",
                                        f"no match (jev: none p={p:.2f}){flag}"))
                    else:
                        results.append((it, "SKIPPED", f"no match (jev p={p:.2f}) UNCHECKED"))
                else:
                    results.append((it, "SKIPPED", "no match UNCHECKED"))
            else:
                results.append((it, "SKIPPED", "no match UNCHECKED"))
        elif len(matches) >= 2:
            if not use_jev:
                results.append((it, "SKIPPED", f"ambiguous ({len(matches)}) UNCHECKED"))
                continue
            m, p = jev_target(text, it, matches)
            if m is None and p is None:
                results.append((it, "SKIPPED", f"ambiguous ({len(matches)}) UNCHECKED"))
            elif m is None:
                flag = " FLAG" if LO <= p < HI else ""
                results.append((it, "SKIPPED",
                                f"ambiguous ({len(matches)}) -> jev: none p={p:.2f}{flag}"))
            elif p >= HI:
                text = text[:m.start()] + it["after"] + text[m.end():]
                results.append((it, "APPLIED", f"jev p={p:.2f}"))
            elif p >= LO:
                text = text[:m.start()] + it["after"] + text[m.end():]
                results.append((it, "APPLIED", f"jev p={p:.2f} FLAG"))
            else:
                results.append((it, "SKIPPED",
                                f"ambiguous ({len(matches)}) jev p={p:.2f} UNCHECKED"))

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
