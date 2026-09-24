#!/usr/bin/env python3
"""book_engine.py — single entry point for the Book Quality Engine (ADR 0043/0044/0047).

Python 3 stdlib only. Every subcommand accepts --dry-run (print commands, run nothing).
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import REPO, QA, RELEASES, CHAPTERS  # noqa: E402


def run(cmd, dry_run, env=None):
    printable = " ".join(str(c) for c in cmd)
    if env:
        printable = f"QA_CHAPTERS={env.get('QA_CHAPTERS', '')} " + printable
    print(f"[cmd] {printable}")
    if dry_run:
        return 0
    proc = subprocess.run([str(c) for c in cmd], cwd=REPO, env=env, check=False)
    return proc.returncode


def parse_literary():
    """{name: (status, grade)} from literary_assessment_v2.md; plus book overall."""
    res, overall = {}, None
    path = QA / "literary_assessment_v2.md"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"- \*\*Ch (\w+): (PASS|FAIL)\*\* — overall ([A-Z][A-Z+-]*)", line)
            if m:
                res[m.group(1)] = (m.group(2), m.group(3))
            mo = re.match(r"\*\*Overall: (\S+)\*\*", line)
            if mo:
                overall = mo.group(1)
    return res, overall


def parse_layout_blockers():
    """{name: int} FAIL-row counts per chapter section of qa_report_FULL.md."""
    res = {}
    path = QA / "qa_report_FULL.md"
    if not path.exists():
        return res
    current = None
    counts = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"## Chapter (\w+) \(", line)
        if m:
            current = m.group(1)
            counts[current] = 0
            continue
        if current and "| FAIL (" in line:
            counts[current] += 1
    return counts


def parse_baselines():
    res = {}
    base = QA / "baseline"
    for name in CHAPTERS:
        d = base / name
        res[name] = d.is_dir() and any(d.iterdir())
    return res


def newest_literary_run():
    runs = sorted(QA.glob("literary_runs/2026*.json"))
    return str(runs[-1]) if runs else None


def cmd_status(args):
    lay = parse_layout_blockers()
    base = parse_baselines()
    import panel_median
    med = panel_median.compute(3)
    k = med["runs_used"] if med else 0
    print(f"Literary grades: median of {k} runs (panel_median.py, last {med['n_requested'] if med else 3})"
          if med else "Literary grades: — (no valid panel runs)")
    print("| Chapter | Literary | Layout blockers | Baseline approved |")
    print("|---|---|---|---|")
    for name in CHAPTERS:
        if med and name in med["chapters"]:
            c = med["chapters"][name]
            literary = f"{c['verdict']} ({c['overall_letter'] or '—'})"
        else:
            literary = "—"
        b = lay.get(name)
        blockers = str(b) if b is not None else "—"
        print(f"| {name} | {literary} | {blockers} | {'yes' if base.get(name) else 'no'} |")
    print()
    print(f"**Overall: {med['book_overall']}** (median of {k} runs)"
          if med and med["book_overall"] else "**Overall: —**")
    nr = newest_literary_run()
    print(f"Newest literary run: {nr}" if nr else "Newest literary run: —")
    return 0


def cmd_m_baseline(args):
    rc = run(["python3", "scripts/literary_metrics.py"], args.dry_run)
    if rc != 0:
        return rc
    for _ in range(3):  # three sequential panel runs; panel_median then grades on their median
        rc = run(["python3", "scripts/literary_panel.py"], args.dry_run)
        if rc != 0:
            return rc
    return run(["python3", "scripts/panel_median.py"], args.dry_run)


def cmd_m_chapter(args):
    return run(["scripts/regrade2.sh", args.name, args.before_md], args.dry_run)


def cmd_p_chapter(args):
    lit, _ = parse_literary()
    st = lit.get(args.name, (None, None))[0]
    if st == "FAIL" and not args.force:
        print(f"literary gate FAIL for {args.name}; fix content first (ADR 0047) or --force",
              file=sys.stderr)
        return 3
    env = dict(os.environ)
    env["QA_CHAPTERS"] = args.name
    cmd = ["scripts/chapter_proof.sh", args.name]
    if args.next:
        cmd.append(args.next)
    return run(cmd, args.dry_run, env=env)


FIXABLE_RULES = {"SRC-HANDBUILT-LIST", "SRC-MANUAL-SPACE", "SRC-ABOVE0",
                 "SRC-PAR-OVERRIDE", "SRC-DOUBLE-SPACE", "BODY-INDENT",
                 "SRC-HIGHLIGHT"}


def parse_qa_fails(name):
    """{rule_id: fail_count} from qa_report_<name>.md, or None if missing."""
    path = QA / f"qa_report_{name}.md"
    if not path.exists():
        return None
    fails = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\|\s*([A-Z0-9-]+)\s*\|.*\|\s*FAIL\s*\((\d+)\)\s*\|\s*$", line)
        if m:
            fails[m.group(1)] = int(m.group(2))
    return fails


def cmd_p_fix(args):
    env = dict(os.environ)
    env["QA_CHAPTERS"] = args.name
    lit, _ = parse_literary()
    st = lit.get(args.name, (None, None))[0]
    if st == "FAIL" and not args.force and not args.dry_run:
        print(f"literary gate FAIL for {args.name}; fix content first (ADR 0047) or --force",
              file=sys.stderr)
        return 3
    rounds = {}
    for r in (1, 2):
        cmd = ["scripts/chapter_proof.sh", args.name]
        if args.next:
            cmd.append(args.next)
        rc = run(cmd, args.dry_run, env=env)  # non-zero also means "gate failed"; the report decides
        fails = parse_qa_fails(args.name)
        if rc != 0 and fails is None and not args.dry_run:
            return rc
        rounds[r] = fails
        if fails is None:
            print(f"round {r}: qa_report_{args.name}.md not found"
                  f"{' (dry-run: not produced)' if args.dry_run else ' (build problem)'}")
            break
        fixable = sorted(k for k in fails if k in FIXABLE_RULES)
        nofix = sorted(k for k in fails if k not in FIXABLE_RULES)
        print(f"round {r} FAIL rows: "
              + (", ".join(f"{k}={v}" for k, v in sorted(fails.items())) or "none"))
        if not fails or not fixable:
            break
        rc = run(["python3", "scripts/layout_fixers.py", args.name, "--apply"],
                 args.dry_run)
        if rc != 0:
            return rc
        if r == 2:
            print(f"round 2 still FAILing after fixers: "
                  + ", ".join(f"{k}={v}" for k, v in sorted(fails.items())))
    print("| Rule | round 1 FAILs | round 2 FAILs |")
    print("|---|---|---|")
    rules = sorted({k for f in rounds.values() if f for k in f})
    for rid in rules:
        r1 = rounds[1].get(rid, "—") if rounds.get(1) else "—"
        r2 = rounds[2].get(rid, "—") if rounds.get(2) else "—"
        print(f"| {rid} | {r1} | {r2} |")
    last = rounds.get(2) or rounds.get(1) or {}
    nofix = sorted(k for k in last if k not in FIXABLE_RULES)
    print("rules with NO fixer (need the orchestrator): "
          + (", ".join(nofix) if nofix else "none"))
    return 0


def cmd_lint(args):
    """T35-K2: engine_lint.py — every mechanical P-lesson check in one command."""
    return run(["python3", "scripts/engine_lint.py"], args.dry_run)


def cmd_release(args):
    lint_rc = run(["python3", "scripts/engine_lint.py"], args.dry_run)
    if lint_rc != 0:
        print("release REFUSED: engine_lint failed (fix the P-lesson checks first)", file=sys.stderr)
        return lint_rc
    lit, _ = parse_literary()
    lay = parse_layout_blockers()
    if not args.force:
        bad = []
        for name in CHAPTERS:
            st = lit.get(name, (None, None))[0]
            b = lay.get(name)
            if st != "PASS" or (b is not None and b > 0):
                bad.append(f"{name}: literary={st or '—'}, blockers={b if b is not None else '—'}")
        if bad:
            print("release gate FAILED (use --force to override):")
            for b in bad:
                print(f"  - {b}")
            return 3
    env = dict(os.environ)
    env["QA_CHAPTERS"] = ",".join(CHAPTERS)
    rc = run(["scripts/chapter_proof.sh", "FULL"], args.dry_run, env=env)
    if rc != 0:
        return rc
    src = RELEASES / "proofs" / "proof_to_ch_FULL.pdf"
    if not src.exists():
        print(f"BLOCKED: missing {src}", file=sys.stderr)
        return 1
    import datetime
    stamp = datetime.date.today().isoformat()
    dest_dir = RELEASES / f"{stamp}_{args.label}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{__import__('book_config').CFG.get('release_prefix', __import__('book_config').BOOK_ID)}_{args.label}.pdf"
    print(f"[cmd] copy {src} -> {dest}")
    if not args.dry_run:
        shutil.copyfile(src, dest)
        shutil.copyfile(QA / "qa_report_FULL.md", dest_dir / "qa_report_FULL.md")
    print(dest.resolve())
    # T35-K4: automated accessibility gate (veraPDF PDF/UA-1 + contrast) on the release PDF.
    rc = run(["bash", "scripts/pdf_a11y_check.sh", str(dest)], args.dry_run)
    if rc != 0 and not args.force:
        print("release REFUSED: pdf_a11y_check failed (use --force to override)", file=sys.stderr)
        return rc
    # T36-J8: financial-advice compliance gate on the manuscript before shipping.
    rc = run(["python3", "scripts/compliance_check.py"], args.dry_run)
    if rc != 0 and not args.force:
        print("release REFUSED: compliance_check BLOCKed a sentence (use --force to override)", file=sys.stderr)
        return rc
    win = subprocess.run(["wslpath", "-w", str(dest)], capture_output=True, text=True, cwd=REPO)
    if win.returncode == 0 and win.stdout.strip():  # P-12: hand over a real Windows path
        print(win.stdout.strip())
    else:
        print(f"(Windows path: \\\\wsl$\\<distro>{dest.resolve()})")
    return 0


def main():
    p = argparse.ArgumentParser(prog="book_engine.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ["status", "m-baseline", "m-chapter", "p-chapter", "p-fix", "lint", "release"]:
        sp = sub.add_parser(name)
        sp.add_argument("--dry-run", action="store_true")
    sub.choices["m-chapter"].add_argument("name", choices=CHAPTERS)
    sub.choices["m-chapter"].add_argument("before_md")
    sub.choices["p-chapter"].add_argument("name", choices=CHAPTERS)
    sub.choices["p-chapter"].add_argument("next", nargs="?", choices=CHAPTERS)
    sub.choices["p-chapter"].add_argument("--force", action="store_true")
    sub.choices["p-fix"].add_argument("name", choices=CHAPTERS)
    sub.choices["p-fix"].add_argument("next", nargs="?", choices=CHAPTERS)
    sub.choices["p-fix"].add_argument("--force", action="store_true")
    sub.choices["release"].add_argument("label")
    sub.choices["release"].add_argument("--force", action="store_true")
    sub.choices["status"].set_defaults(func=cmd_status)
    sub.choices["m-baseline"].set_defaults(func=cmd_m_baseline)
    sub.choices["m-chapter"].set_defaults(func=cmd_m_chapter)
    sub.choices["p-chapter"].set_defaults(func=cmd_p_chapter)
    sub.choices["p-fix"].set_defaults(func=cmd_p_fix)
    sub.choices["lint"].set_defaults(func=cmd_lint)
    sub.choices["release"].set_defaults(func=cmd_release)
    args = p.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
