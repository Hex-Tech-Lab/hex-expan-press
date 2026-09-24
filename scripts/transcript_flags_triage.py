#!/usr/bin/env python3
"""Triage the transcript-number FLAGs that reach the book (founder request 2026-09-26).
Input: <QA>/transcript_numbers_book_hits.json (written by transcript_numbers_stats.py): flagged numbers
that also appear in a fact card from the same video.
For each: Jev choice — is the fact card's figure right given the transcript sentence? Then checks whether
the card's figures actually appear in the manuscript. Advisory only (Rule 0): it never edits a card or
the book; it proposes creator-queue items.
Writes <QA>/transcript_flags_triage.md (+ .html).

Usage: python3 scripts/transcript_flags_triage.py [--no-jev]
"""
import hashlib
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import MS, QA, REPO  # noqa: E402
from jev import decide  # noqa: E402

VERDICTS = {
    "card_correct": "the fact card states the figure the speaker clearly meant",
    "card_wrong": "the fact card states a figure the speaker did not mean (misread caption, wrong unit or period)",
    "needs_video": "the transcript is too garbled to tell; someone must listen to the video",
    "not_a_figure": "the flagged 'number' is not a figure at all (e.g. '401' from '401k', a stray year)",
}
Q = {"verdict": {"type": "choice",
                 "instructions": "The transcript sentence came from speech-to-text. The fact card is our reading "
                                 "of it. Is the fact card's figure right?",
                 "criteria": VERDICTS}}
FIG = re.compile(r"\$?\d[\d,]*(?:\.\d+)?%?")


def figures(text):
    return {re.sub(r"[$,]", "", f).rstrip(".") for f in FIG.findall(text) if len(re.sub(r"\D", "", f)) >= 2}


def main():
    use_jev = "--no-jev" not in sys.argv
    hits = json.loads((QA / "transcript_numbers_book_hits.json").read_text())
    book = re.sub(r"[$,]", "", MS.read_text())
    cache_path = QA / "jev_cache_flag_triage.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    def key(h):
        return hashlib.sha1(f"{h['file']}|{h['line']}|{h['num']}|{h['cards'][0]['card']}".encode()).hexdigest()

    def ask(h):
        k = key(h)
        if k in cache or not use_jev:
            return
        a = decide({"flagged_number": h["num"], "transcript_sentence": h["sentence"],
                    "fact_card": h["cards"][0]["card"]}, Q, timeout=20)
        if a:
            probs = a["verdict"].get("probabilities") or {}
            cache[k] = {"verdict": a["verdict"].get("choice"), "p": max(probs.values()) if probs else None}

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(ask, hits))
    cache_path.write_text(json.dumps(cache, indent=0))

    groups = {k: [] for k in list(VERDICTS) + ["unsure"]}
    for h in hits:
        c = cache.get(key(h))
        v = c["verdict"] if c and c["p"] is not None and c["p"] >= 0.5 and c["verdict"] in VERDICTS else "unsure"
        card = h["cards"][0]
        in_book = sorted(f for f in figures(card["card"]) if f in book)
        groups[v].append((h, card, c["p"] if c else None, in_book))

    out = ["# Transcript FLAGs that reach the book: triage", "",
           f"{len(hits)} flagged numbers appear in a fact card from the same video. Jev judged each fact card "
           "against the transcript sentence. **In book** lists the card's figures that appear verbatim in the "
           "current manuscript. Advisory only: nothing was edited.", "",
           "| Verdict | Count | Meaning |", "|---|---|---|"]
    for k, items in groups.items():
        out.append(f"| {k} | {len(items)} | {VERDICTS.get(k, 'Jev below 0.5 confidence; treat as needs_video')} |")
    out.append("")
    for k in ["card_wrong", "needs_video", "unsure", "card_correct", "not_a_figure"]:
        items = groups[k]
        if not items:
            continue
        out += [f"## {k} ({len(items)})", ""]
        for h, card, p, in_book in sorted(items, key=lambda x: (not x[3], -(x[2] or 0))):
            pp = "" if p is None else f" p={p:.2f}"
            ib = f" **In book: {', '.join(in_book)}**" if in_book else " (not in book text)"
            out.append(f"- `{h['file']}:{h['line']}` [{card['chapter']}]{pp}{ib}  \n"
                       f"  transcript: \"{h['sentence'][:180]}\"  \n  card: \"{card['card'][:220]}\"")
        out.append("")
    rep = QA / "transcript_flags_triage.md"
    rep.write_text("\n".join(out) + "\n")
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)], cwd=REPO)
    print("TRIAGE: " + ", ".join(f"{k}={len(v)}" for k, v in groups.items()) + f" -> {rep}")


if __name__ == "__main__":
    main()
