#!/usr/bin/env python3
"""Surface-claims check (T37-W1a, B13 + B14).

B13 — cover promise: Jev noul `promise_supported` on the cover strings plus three short
book spans: the Ch1 "three legs" passage ("second income I never planned"), the Ch5
sentence about YouTube income covering the zero-withdrawal years, and the Ch1 opening
claim ("you don't need a million dollars").

B14 — blurb figures: every number/$ amount/date in the cover strings and the back-cover
text is looked up in the chapters' prose (exact or normalised: $548,000 = 548K).
Missing -> FAIL. Present -> Jev noul `same_meaning` on the blurb sentence vs the best
book sentence containing that number (<0.5 FLAG: number used differently).

Exit 1 on FAIL or promise_supported < 0.5. Writes <QA>/surface_claims_report.md
(rendered to .html via render_report.sh). RULE 0: reports only; never edits the book.

Usage: python3 scripts/surface_claims_check.py [--no-jev]
"""
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import REPO, QA, CFG, MS, chapter_sources  # noqa: E402
from literary_metrics import prose  # noqa: E402
from jev import decide  # noqa: E402

LO = 0.5
PROMISE_Q = {"promise_supported": {"type": "noul",
    "instructions": "COVER = a book cover's promise to a reader. BOOK SPANS = passages from the book itself. "
                    "Is the cover's promise (the bold claim about the method and the money) supported by the "
                    "book's own central claim and the passages shown?",
    "criteria": {"true": "The cover promise is supported by the book's central claim and passages.",
                 "false": "The cover promises something the book does not claim or support."}}}
SAME_MEANING_Q = {"same_meaning": {"type": "noul",
    "instructions": "Two sentences both mention the NUMBER shown. Is the number used with the SAME MEANING in "
                    "both (same quantity: money, date, age, count)?",
    "criteria": {"true": "Same quantity/meaning in both sentences.",
                 "false": "The number means something different in the two sentences (e.g. a different amount, "
                          "year, age or unit)."}}}

WORD_NUMS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
             "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "twenty": 20, "thirty": 30,
             "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
             "hundred": 100, "thousand": 1000, "million": 1000000}


def cover_strings():
    c = CFG.get("cover", {})
    out = []
    for k, v in c.items():
        if isinstance(v, list):
            out.append((k, " ".join(v)))
        else:
            out.append((k, str(v)))
    return out


def backcover_text():
    """The back-cover text: the manuscript block after '// BACK COVER', hook + blurbs from #text(...)[...] blocks."""
    t = MS.read_text()
    i = t.find("// BACK COVER")
    if i < 0:
        return ""
    block = t[i:]
    parts = [m.group(1) for m in re.finditer(r"#text\([^)]*\)\[\s*(.*?)\n\s*\]", block, re.S)]
    return "\n\n".join(p.strip() for p in parts if p.strip())


def normalize(n):
    """'548,000'/'$548,000'/'548K' -> int 548000; '2022' -> 2022."""
    s = n.replace("$", "").replace(",", "").strip().lower()
    m = re.match(r"^(\d+(?:\.\d+)?)k$", s)
    if m:
        return int(float(m.group(1)) * 1000)
    try:
        return int(float(s))
    except ValueError:
        return None


def word_number_value(text):
    """Word-form value for phrases like 'fifty-nine', 'half a million', 'five years'."""
    s = text.lower()
    if "half a million" in s:
        return 500000
    s = s.replace("-", " ")
    if not re.fullmatch(r"(?:\w+ )*(?:\w+)", s):
        return None
    toks = s.split()
    if any(t not in WORD_NUMS for t in toks):
        return None
    total, cur = 0, 0
    for t in toks:
        v = WORD_NUMS[t]
        if v in (100, 1000, 1000000):
            cur = max(cur * v, v)
            total += cur
            cur = 0
        else:
            cur += v
    return total + cur


def numbers_in(text):
    """[(token, value)] for every number/$ amount/date in text."""
    out, seen = [], set()
    for m in re.finditer(r"\$\d[\d,]*(?:\.\d+)?(?:\s?K\b)?|\b\d[\d,]*(?:\.\d+)?\b", text):
        tok = m.group(0)
        if tok.startswith("401") and re.match(r"401[\d,]*", text[m.start():m.start() + 10]) and text[m.end():m.end() + 1] == "(":
            continue  # 401(k) is a product name, not a number
        val = normalize(tok)
        if val is not None and (tok, val) not in seen:
            seen.add((tok, val))
            out.append((tok, val))
    for m in re.finditer(r"\b(?:fifty-nine|fifty|sixty|forty|five|two|three|ten|nineteen)\b"
                         r"(?:-(?:nine|one|two|three|four|five|six|seven|eight))?|\bhalf a million\b", text, re.I):
        val = word_number_value(m.group(0))
        if val is not None and (m.group(0), val) not in seen:
            seen.add((m.group(0), val))
            out.append((m.group(0), val))
    return out


def book_prose():
    """{chapter: prose text} for every chapter."""
    return {name: prose(src) for name, _, src in chapter_sources()}


def find_number(chapters_prose, value, cap=5):
    """[(chapter, sentence), ...] for book sentences containing the value, all senses of the number.
    Capped at `cap` candidates, fewest competing numbers first (most likely same sense)."""
    out = []
    for name in chapters_prose:
        for sent in re.split(r"(?<=[.!?])\s+(?=[A-Z\"'$0-9])", chapters_prose[name]):
            if any(val == value for _, val in numbers_in(sent)):
                out.append((name, sent.strip()))
    out.sort(key=lambda cs: len(numbers_in(cs[1])))
    return out[:cap]


def span_around(prose_text, needle, before=1, after=2):
    """A short span of sentences around `needle` in the prose."""
    sents = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'$0-9])", prose_text)
    for i, s in enumerate(sents):
        if needle in s:
            lo, hi = max(0, i - before), min(len(sents), i + after + 1)
            return " ".join(sents[lo:hi])
    return ""


def main():
    use_jev = "--no-jev" not in sys.argv
    cov = cover_strings()
    cov_text = "\n".join(v for _, v in cov)
    bc = backcover_text()
    chapters_prose = book_prose()
    all_prose = "\n".join(chapters_prose.values())
    fails, flags, unchecked = [], [], []

    # --- B13: promise_supported (cover strings + 3 short book spans) ---
    three_legs = span_around(all_prose, "second income I never planned")
    yt = span_around(all_prose, "covering the bills", before=0, after=0)
    opening = span_around(all_prose, "million dollars to retire", before=0, after=1)
    spans_ok = all([three_legs, yt, opening])
    promise_p = None
    if not spans_ok:
        promise_note = "UNCHECKED (span not found: " + ", ".join(
            n for n, s in [("three-legs", three_legs), ("yt-zero-withdrawal", yt), ("opening", opening)] if not s) + ")"
    elif not use_jev:
        promise_note = "UNCHECKED (Jev off)"
    else:
        a = decide({"cover_strings": cov, "book_spans": {
            "ch1_three_legs_passage": three_legs,
            "ch5_youtube_income_covering_the_zero_withdrawal_years": yt,
            "ch1_opening_claim": opening}}, PROMISE_Q, timeout=20)
        if a is None:
            promise_note = "UNCHECKED (Jev unavailable)"
        else:
            promise_p = a["promise_supported"]["noul"]
            promise_note = f"p={promise_p:.2f} ({'SUPPORTED' if promise_p >= LO else 'FAIL'})"
    print(f"B13 promise_supported: {promise_note}")

    # --- B14: every number in cover + back-cover text must appear in the chapters' prose ---
    rows = []
    surface_sents = []
    for src_name, text in [("cover", cov_text), ("back-cover", bc)]:
        for sent in re.split(r"(?<=[.!?])\s+(?=[A-Z\"'$0-9])", text):
            if numbers_in(sent):
                surface_sents.append((src_name, sent.strip()))
    for src_name, sent in surface_sents:
        for tok, val in numbers_in(sent):
            hits = find_number(chapters_prose, val)
            if not hits:
                fails.append(f"{src_name}: {tok} (not found in any chapter)")
                rows.append((src_name, sent, tok, None, None, "FAIL (number missing from the book)"))
                continue
            if not use_jev:
                ch, book_sent = hits[0]
                rows.append((src_name, sent, tok, ch, book_sent, "UNCHECKED (Jev off)"))
                unchecked.append(f"{src_name}: {tok}")
                continue
            best = None  # any book sentence that uses the number the same way clears the figure
            for ch, book_sent in hits:
                a = decide({"blurb_sentence": sent, "book_sentence": book_sent, "number": tok},
                           SAME_MEANING_Q, timeout=20)
                if a is None:
                    continue
                p = a["same_meaning"]["noul"]
                if best is None or p > best[2]:
                    best = (ch, book_sent, p)
            if best is None:
                rows.append((src_name, sent, tok, hits[0][0], hits[0][1], "UNCHECKED (Jev unavailable)"))
                unchecked.append(f"{src_name}: {tok}")
                continue
            ch, book_sent, p = best
            if p < LO:
                flags.append(f"{src_name}: {tok} (p={p:.2f}, Ch {ch})")
                rows.append((src_name, sent, tok, ch, book_sent, f"FLAG (number used differently, p={p:.2f})"))
            else:
                rows.append((src_name, sent, tok, ch, book_sent, f"PASS (p={p:.2f})"))

    out = ["# SURFACE CLAIMS — cover promise + blurb figures (T37-W1a, B13/B14)", ""]
    out.append("## B13 cover promise (promise_supported)")
    out.append("")
    out.append(f"- {promise_note}")
    if three_legs:
        out.append(f"- three-legs span: {three_legs[:400]}")
    if yt:
        out.append(f"- zero-withdrawal span: {yt[:400]}")
    if opening:
        out.append(f"- opening-claim span: {opening[:400]}")
    out.append("")
    out.append(f"## B14 figures — {len(rows)} checked, {len(fails)} FAIL, {len(flags)} FLAG, {len(unchecked)} UNCHECKED")
    out.append("")
    out.append("| surface | number | book chapter | blurb sentence | book sentence | verdict |")
    out.append("|---|---|---|---|---|---|")
    for src_name, sent, tok, ch, book_sent, verdict in rows:
        bs = (book_sent or "").replace("|", "\\|")[:180]
        out.append(f"| {src_name} | {tok} | {ch or '—'} | {sent.replace('|', chr(92)+'|')[:180]} | {bs} | {verdict} |")
    out.append("")
    if fails:
        out.append("## FAILURES (number missing from the book)")
        out.extend(f"- {f}" for f in fails)
        out.append("")
    if flags:
        out.append("## FLAGS (number used differently)")
        out.extend(f"- {f}" for f in flags)
        out.append("")
    rep = QA / "surface_claims_report.md"
    rep.write_text("\n".join(out))
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
    bad = fails or (promise_p is not None and promise_p < LO) or not spans_ok
    print(f"SURFACE CLAIMS: {'FAIL' if bad else 'PASS'} "
          f"({len(fails)} FAIL, {len(flags)} FLAG, {len(unchecked)} UNCHECKED; promise {promise_note}) -> {rep}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
