#!/usr/bin/env python3
"""Stats + Jev classification for the transcript-number scan (founder request 2026-09-26).
Reads <QA>/transcript_numbers_rows.json (written by transcript_numbers_check.py), the channel metadata,
and the chapter fact cards. Asks Jev ONE choice question per FLAG row (cached): what kind of problem
it is. Advisory only (Rule 0): it ranks what to look at; it never edits a fact card or the book.
Writes <QA>/transcript_numbers_stats.md (+ .html).

Usage: python3 scripts/transcript_numbers_stats.py [--no-jev] [--elapsed SECONDS]
"""
import collections
import hashlib
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA, REPO  # noqa: E402
from jev import decide  # noqa: E402

SAMPLES = REPO / "data/db/samples/duane_retirearly500"
FACTS = REPO / "data/intel/duane_book/facts"
COST_PER_CALL = (0.00002, 0.00008)  # qa/cost_reference.md, measured 2026-09-24
KINDS = {
    "stt_mishearing": "speech-to-text misheard the number (e.g. fifteen vs fifty, '$5,18')",
    "garbled_format": "the number is split, merged or formatted wrongly but the intended value is clear",
    "inconsistent_value": "the number contradicts other numbers in the same passage (a real speaker slip or a changed figure)",
    "ambiguous_unit": "the value may be right but its unit or period is unclear (a month vs a year, thousands vs units)",
    "false_alarm": "the number is correct and consistent; nothing to fix",
}
Q = {"kind": {"type": "choice", "instructions": "What kind of problem, if any, does this transcript number have?",
              "criteria": KINDS}}


def num_type(n):
    n = n.strip(".,")
    if n.startswith("$"):
        return "dollar amount"
    if n.endswith("%"):
        return "percent"
    if re.fullmatch(r"(?:19|20)\d\d", n):
        return "year"
    if re.fullmatch(r"[A-Za-z]+", n):
        return "spoken word"
    return "other digits"


def fact_sources():
    """video id -> list of fact-card claims that cite it."""
    src = collections.defaultdict(list)
    for f in sorted(FACTS.glob("ch*.md")):
        for card in f.read_text().split("### ")[1:]:
            claim = re.search(r"^claim: (.*)$", card, re.M)
            vid = re.search(r"^source: (\S+)", card, re.M)
            quote = re.search(r"^quote: (.*)$", card, re.M)
            if claim and vid:
                src[vid.group(1)].append((f.stem, claim.group(1) + " " + (quote.group(1) if quote else "")))
    return src


def main():
    use_jev = "--no-jev" not in sys.argv
    m = re.search(r"--elapsed[= ](\d+)", " ".join(sys.argv))
    elapsed = int(m.group(1)) if m else None
    m = re.search(r"--measured[= ]([\d.]+)", " ".join(sys.argv))
    measured = m.group(1) if m else None
    rows = json.loads((QA / "transcript_numbers_rows.json").read_text())
    meta = json.loads((SAMPLES / "metadata.json").read_text())
    channel_total = meta.get("youtube", {}).get("total_videos_seen")
    txts = list((SAMPLES / "transcripts").glob("*.txt"))
    words = sum(len(t.read_text(errors="replace").split()) for t in txts)
    srcs = fact_sources()

    vid = lambda name: name.split(".")[0]  # noqa: E731
    flags = [r for r in rows if r["v"] == "FLAG"]
    unc = [r for r in rows if r["v"].startswith("UNCHECKED")]
    checked = [r for r in rows if r["p"] is not None]

    # Jev classification of every FLAG (cached per row).
    cache_path = QA / "jev_cache_transcript_kinds.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    def key(r):
        return hashlib.sha1(f"{r['file']}|{r['line']}|{r['num']}|{r['sentence']}".encode()).hexdigest()

    def classify(r):
        k = key(r)
        if k in cache or not use_jev:
            return
        a = decide({"number": r["num"], "sentence": r["sentence"]}, Q, timeout=20)
        if a:
            probs = a["kind"].get("probabilities") or {}
            cache[k] = {"kind": a["kind"].get("choice"), "p": max(probs.values()) if probs else None}

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(classify, flags))
    cache_path.write_text(json.dumps(cache, indent=0))
    for r in flags:
        c = cache.get(key(r))
        r["kind"] = c["kind"] if c and c["p"] is not None and c["p"] >= 0.5 else "unclassified (Jev unsure/down)"
        r["book_source"] = vid(r["file"]) in srcs

    out = ["# Transcript numbers — scan statistics", ""]
    out += ["## Coverage", "",
            "| Measure | Value |", "|---|---|",
            f"| Videos on the channel (metadata) | {channel_total if channel_total is not None else 'unknown'} |",
            f"| Videos with a transcript | {len(txts)} |",
            f"| Words transcribed | {words:,} |",
            f"| Videos containing money/age/year numbers | {len({vid(r['file']) for r in rows})} |",
            f"| Number instances found | {len(rows):,} |",
            f"| Checked by Jev | {len(checked):,} ({100 * len(checked) / max(1, len(rows)):.1f}%) |",
            f"| FLAG (probably misheard/inconsistent, p ≥ 0.5) | {len(flags)} ({100 * len(flags) / max(1, len(checked)):.1f}% of checked) |",
            f"| UNCHECKED (Jev did not answer) | {len(unc)} |",
            f"| Videos cited by the book's fact cards | {len(srcs)} |",
            f"| FLAGs in videos the book cites | {sum(r['book_source'] for r in flags)} |", ""]
    n_calls = len(checked) + len(flags)
    lo, hi = (n_calls * c for c in COST_PER_CALL)
    out += ["## Spend", "",
            f"- Jev calls: {len(checked):,} number checks + {len(flags)} classifications = **{n_calls:,} calls**",
            f"- Estimated cost: **${lo:.2f}–${hi:.2f}** (at ${COST_PER_CALL[0]}–${COST_PER_CALL[1]} per call, qa/cost_reference.md)",
            *( [f"- **Measured** (OpenRouter key usage before/after): ${measured}"] if measured else []),
            *( [f"- Wall time of the scan: {elapsed // 60} min {elapsed % 60} s (8 parallel calls)"] if elapsed else []), ""]

    out += ["## Jev confidence bands (all checked numbers)", "", "| p(misheard) | Count |", "|---|---|"]
    bands = [("< 0.2 clean", 0, .2), ("0.2–0.5 low", .2, .5), ("0.5–0.8 FLAG", .5, .8), ("≥ 0.8 strong FLAG", .8, 1.01)]
    for name, a, b in bands:
        out.append(f"| {name} | {sum(a <= r['p'] < b for r in checked)} |")
    out.append("")

    out += ["## By number type", "", "| Type | Found | FLAG | FLAG rate |", "|---|---|---|---|"]
    by_t = collections.Counter(num_type(r["num"]) for r in rows)
    fl_t = collections.Counter(num_type(r["num"]) for r in flags)
    for t, n in by_t.most_common():
        out.append(f"| {t} | {n} | {fl_t[t]} | {100 * fl_t[t] / n:.1f}% |")
    out.append("")

    out += ["## FLAGs classified by Jev", "", "| Kind | Count | Meaning |", "|---|---|---|"]
    for k, n in collections.Counter(r["kind"] for r in flags).most_common():
        out.append(f"| {k} | {n} | {KINDS.get(k, '')} |")
    out.append("")

    out += ["## Videos with the most FLAGs", "", "| Video | Numbers | FLAG | Cited by book |", "|---|---|---|---|"]
    per = collections.Counter(vid(r["file"]) for r in rows)
    per_f = collections.Counter(vid(r["file"]) for r in flags)
    for v, n in per_f.most_common(15):
        cited = ", ".join(sorted({c for c, _ in srcs.get(v, [])})) or "—"
        out.append(f"| {v} | {per[v]} | {n} | {cited} |")
    out.append("")

    # Sharpest list: the flagged number itself appears in a fact card sourced from the same video,
    # i.e. it can be printed in the book as-is.
    def in_card(r):
        core = re.sub(r"[^\d.]", "", r["num"]).strip(".")
        if not core or len(core) < 2:
            return []
        return [(c, t) for c, t in srcs.get(vid(r["file"]), []) if core in re.sub(r"[,$%]", "", t)]

    hits = [(r, in_card(r)) for r in flags if r["kind"] != "false_alarm"]
    hits = sorted([(r, h) for r, h in hits if h], key=lambda x: -x[0]["p"])
    out += ["## Reaches the book: flagged number appears in a fact card from the same video", "",
            f"**{len(hits)} items.** These are the ones to check first against the transcript audio/video.", ""]
    for r, h in hits:
        c, t = h[0]
        out.append(f"- **{r['kind']}** (p={r['p']:.2f}) `{r['file']}:{r['line']}` number `{r['num']}` → "
                   f"{c} fact card: \"{t[:160]}\"")
    if not hits:
        out.append("- none")
    out.append("")

    pri = sorted([r for r in flags if r["book_source"] and r["kind"] != "false_alarm"], key=lambda r: -r["p"])
    out += ["## Priority: FLAGs in videos the book cites (not false alarms)", "",
            "These can reach the book through a fact card. Check each against the chapter's fact cards.", ""]
    for r in pri:
        cited = ", ".join(sorted({c for c, _ in srcs[vid(r['file'])]}))
        out.append(f"- **{r['kind']}** (p={r['p']:.2f}) `{r['file']}:{r['line']}` [{cited}] number `{r['num']}`: {r['sentence']}")
    if not pri:
        out.append("- none")
    out.append("")
    rep = QA / "transcript_numbers_stats.md"
    rep.write_text("\n".join(out) + "\n")
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)], cwd=REPO)
    print(f"STATS: {len(rows)} numbers, {len(flags)} FLAG, {len(pri)} priority -> {rep}")


if __name__ == "__main__":
    main()
