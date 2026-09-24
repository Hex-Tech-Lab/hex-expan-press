#!/usr/bin/env python3
"""Claims-with-evidence check (T37-W1c, I10+I20): audits a handover / release README / agent REPORT block.

Input: one markdown file. Extracts lines claiming success ("PASS", "done", "fits", "identical",
"verified", "0 failing", counts like "7/7"). For each claim:
  - if the claim names a file path, check it exists (os.path)
  - look for pasted evidence in the surrounding 8 lines (command `$ ...` or an output line)
  - ask Jev noul `claim_backed` given the claim + its surrounding 8 lines
Bands: >= 0.8 backed, 0.5-0.8 FLAG, < 0.5 UNBACKED; Jev down / --no-jev -> UNCHECKED.
Writes <QA>/claims_evidence_report.md and renders .html. Reports only — never edits anything.

Usage: python3 scripts/claims_evidence_check.py <file.md> [--no-jev]
"""
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA  # noqa: E402
from jev import decide  # noqa: E402

LO, HI = 0.5, 0.8
CLAIM_RE = re.compile(
    r"\b(?:PASS|passed|done|fits|identical|verified|0 failing|complete[d]?|OK)\b"
    r"|\b\d+\s*/\s*\d+\b", re.I)
CMD_RE = re.compile(r"(?m)^(?:\$|> )\S|`[^`]+`|exit code 0|exit 0", re.I)
PATH_RE = re.compile(r"(?:[\w./-]+/)*[\w.-]+\.(?:md|py|ts|sh|json|jsonl|pdf|html|typ|txt|vtt)")
Q = {"claim_backed": {"type": "noul",
    "instructions": "Is this claim of success backed by concrete evidence in the document: a pasted command "
                    "and its output, a verified file, or a stated measurement — versus an assertion alone?",
    "criteria": {"true": "Concrete evidence for the claim appears in the document.",
                 "false": "The claim is asserted without supporting evidence in the document."}}}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: claims_evidence_check.py <file.md> [--no-jev]")
        sys.exit(2)
    use_jev = "--no-jev" not in sys.argv
    src = Path(args[0])
    lines = src.read_text().splitlines()
    rows = []
    for i, line in enumerate(lines):
        if not CLAIM_RE.search(line):
            continue
        ctx = "\n".join(lines[max(0, i - 4):i + 8])
        evidence = "no"
        if CMD_RE.search(ctx):
            evidence = "pasted command/output nearby"
        paths = [p for p in PATH_RE.findall(line) if "/" in p or p.endswith((".md", ".pdf", ".json"))]
        missing = [p for p in paths
                   if not os.path.exists(p if os.path.isabs(p) else os.path.join(os.getcwd(), p))]
        if paths and not missing:
            evidence = "named files exist"
        if use_jev:
            a = decide({"claim": line.strip(), "context": ctx, "evidence": evidence}, Q, timeout=20)
            p = a["claim_backed"]["noul"] if a else None
            v = ("UNCHECKED (Jev unavailable)" if p is None
                 else "PASS" if p >= HI else "FLAG" if p >= LO else "UNBACKED")
        else:
            p, v = None, "UNCHECKED (Jev off)"
        rows.append((i + 1, line.strip()[:120], evidence, missing, p, v))
    out = [f"# CLAIMS-EVIDENCE — {src}", "",
           f"{len(rows)} success claims; UNBACKED/FLAG listed below.", ""]
    for ln, text, ev, missing, p, v in rows:
        extra = f"; missing files: {', '.join(missing)}" if missing else ""
        out.append(f"- **{v}**{'' if p is None else f' (p={p:.2f})'} line {ln}: {text}"
                   f" — evidence: {ev}{extra}")
    out += ["", "## UNBACKED / FLAG summary", ""]
    bad = [r for r in rows if r[5] in ("UNBACKED", "FLAG")]
    if bad:
        out += [f"- line {r[0]} ({r[5]}): {r[1]}" for r in bad]
    else:
        out.append("- none")
    rep = QA / "claims_evidence_report.md"
    rep.write_text("\n".join(out))
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
    print(f"CLAIMS-EVIDENCE: {len(bad)} UNBACKED/FLAG of {len(rows)} claims -> {rep}")


if __name__ == "__main__":
    main()
