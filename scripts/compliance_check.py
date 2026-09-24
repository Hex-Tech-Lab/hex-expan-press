#!/usr/bin/env python3
"""Jev gate: financial-advice compliance (T36-J8). For each chapter's prose, pre-filters sentences
that look like personal financial advice (imperative money verbs, "you should/must/need to",
tickers/fund names, "guaranteed", "risk-free", "will return") and asks Jev two noul questions:
  personal_advice  - does it tell THIS reader what to do with their money, vs. the author's own
                     choice or a general fact?
  guarantee_claim  - does it promise or imply a guaranteed financial outcome?
Bands (engine_workflow): either p >= 0.8 -> BLOCK (must be reworded as the author's own
choice/opinion), 0.5-0.8 -> FLAG (listed in report), < 0.5 -> pass; Jev down / --no-jev -> UNCHECKED
(current behaviour). Writes <QA>/compliance_report.md (rendered to .html via render_report.sh).
Exit 1 on any BLOCK.

Usage: python3 scripts/compliance_check.py [--no-jev]
"""
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA, chapter_sources  # noqa: E402
from literary_metrics import prose  # noqa: E402
from jev import decide  # noqa: E402

LO, HI = 0.5, 0.8
QUESTIONS = {
    # BLOCK-level: the lines that matter for a book that is not licensed advice (founder 2026-09-24:
    # general money habits in a memoir-guide with advice disclaimers are INFO, not blockers).
    "specific_recommendation": {"type": "noul",
        "instructions": "Does this sentence recommend that THE READER buy, sell or hold a specific named security, fund, "
                        "annuity product or provider, or adopt a specific portfolio allocation for their own money? "
                        "General habits (save, keep cash, take the employer match, budget arithmetic) do NOT count. "
                        "Use CONTEXT: if it is framed as the author's own rule or choice, it does not count.",
        "criteria": {"true": "It recommends a specific investment product, security, provider or allocation to the reader.",
                     "false": "It is a general habit, arithmetic, the author's own choice, or a story."}},
    "guarantee_claim": {"type": "noul",
        "instructions": "Does it promise or imply a guaranteed or certain financial outcome for the reader?",
        "criteria": {"true": "It promises, implies or predicts a certain/assured financial result.",
                     "false": "No guaranteed outcome is promised or implied."}},
    "general_habit": {"type": "noul",
        "instructions": "Is this a general money-habit instruction to the reader (save, budget, keep a reserve)?",
        "criteria": {"true": "A general habit addressed to the reader.", "false": "Not a general habit instruction."}},
}
# Pre-filter: imperative money verbs (sentence starts with one), second-person advice,
# tickers ($XXX) / fund names, guarantee language, return promises.
VERBS = r"buy|sell|invest|save|spend|open|fund|max|contribute|withdraw|put|move|roll|keep|take|hold|cash"
PREFILTER = re.compile(
    r"^(?:" + VERBS + r")\b"
    r"|\byou (?:should|must|need to|ought to|have to)\b"
    r"|\b(?:guaranteed|guarantee|risk-free|risk free)\b"
    r"|\bwill return\b"
    r"|\$[A-Za-z]{2,5}\b"
    r"|\b(?:fund|etf|index fund|mutual fund|roth|ira|401\(k\))\b", re.I)


def sentences(text):
    """[(sentence, previous sentence)] for sentences that pass the pre-filter (context lets Jev see framing
    such as "These are my rules, not advice for yours")."""
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z\"'$0-9])", text) if len(s.split()) > 3]
    return [(s, sents[i - 1] if i else "") for i, s in enumerate(sents) if PREFILTER.search(s)]


def main():
    use_jev = "--no-jev" not in sys.argv
    blocks, worst = [], 0
    for name, title, src in chapter_sources():
        rows = []
        for s, ctx in sentences(prose(src)):
            if not use_jev:
                rows.append((s, None, "UNCHECKED (Jev off)"))
                continue
            a = decide({"context": ctx, "sentence": s}, QUESTIONS, timeout=20)
            if a is None:
                rows.append((s, None, "UNCHECKED (Jev unavailable)"))
                continue
            rec, gar, hab = (a["specific_recommendation"]["noul"], a["guarantee_claim"]["noul"],
                             a["general_habit"]["noul"])
            p = max(rec, gar)
            if p >= HI:
                v = "BLOCK"
                worst = 1
            elif p >= LO:
                v = "FLAG"
            elif hab >= HI:
                v, p = "INFO (general habit, covered by the disclaimer)", hab
            else:
                v = "PASS"
            rows.append((s, p, v))
        n_block = sum(r[2] == "BLOCK" for r in rows)
        n_flag = sum(r[2] == "FLAG" for r in rows)
        n_unc = sum(r[2].startswith("UNCHECKED") for r in rows)
        blocks.append((name, title, rows, n_block, n_flag, n_unc))
    out = ["# COMPLIANCE — financial-advice gate (T36-J8)", ""]
    for name, title, rows, nb, nf, nu in blocks:
        out.append(f"## Chapter {name}: {title} — {len(rows)} filtered sentences, "
                   f"{nb} BLOCK, {nf} FLAG, {nu} UNCHECKED")
        out.append("")
        for s, p, v in rows:
            out.append(f"- **{v}**{'' if p is None else f' (p={p:.2f})'}: {s}")
        out.append("")
    rep = QA / "compliance_report.md"
    rep.write_text("\n".join(out))
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
    tot_b = sum(b[3] for b in blocks)
    print(f"COMPLIANCE: {'FAIL' if tot_b else 'PASS'} ({tot_b} BLOCK, {sum(b[4] for b in blocks)} FLAG, "
          f"{sum(b[5] for b in blocks)} UNCHECKED) -> {rep}")
    sys.exit(1 if worst else 0)


if __name__ == "__main__":
    main()
