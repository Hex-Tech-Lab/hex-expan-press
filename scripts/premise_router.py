#!/usr/bin/env python3
"""T5: route reader-stop clusters + contradictions to the creator queue as proposals.

Read-only inputs:
  <QA>/literary_runs/2026*.json   (patch_* excluded)
  <QA>/chapter_briefs/ch*_regrade_run*.json
  <QA>/duane_review_queue.md      (read-only, never edited)
Writes:
  <QA>/creator_queue_proposals.md
Python 3 stdlib only.
"""
import glob
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA as QA_DIR, CHAPTERS  # noqa: E402
from jev import decide  # noqa: E402

QA = str(QA_DIR)
OUT = os.path.join(QA, "creator_queue_proposals.md")
QUEUE = os.path.join(QA, "duane_review_queue.md")

THEMES = [
    ("side_income", re.compile(r"youtube|channel|side income|flow|advertis", re.I)),
    ("job_loss", re.compile(r"ageism|laid off|job|applications|feelers", re.I)),
    ("debt", re.compile(r"loan|borrow", re.I)),
]


def classify(text):
    for name, rx in THEMES:
        if rx.search(text):
            return name
    return "other"


def classify_jev(quote):
    """Jev choice over the theme names + 'other'; falls back to the keyword classifier when Jev is
    down or the top probability < 0.5. Returns (theme, p, via)."""
    a = decide({"quote": quote}, {"theme": {
        "type": "choice",
        "instructions": "Which reader-stop theme best fits this reader's stop-at quote?",
        "criteria": {"side_income": "about earning extra money, a side business, channels, ads, income flows",
                     "job_loss": "about losing or finding a job, ageism, layoffs, applications",
                     "debt": "about loans or borrowing",
                     "other": "none of the themes above"}}}, timeout=10)
    if a is None:
        return classify(quote), None, "keyword"
    t = a["theme"].get("choice")
    p = max((a["theme"].get("probabilities") or {"": 1}).values())
    if p < 0.5 or t not in {n for n, _ in THEMES} | {"other"}:
        return classify(quote), p, "keyword"
    return t, p, "jev"


def triage_jev(c):
    """Plan point 3a: Jev noul `real_contradiction` triage for a G1 candidate pair. Returns
    (p or None). p < 0.5 -> dismiss; None -> keep (Jev down, current behaviour)."""
    a = decide({"statement_a": f"(Ch {c['a'].get('chapter')}) {c['a'].get('quote')}",
                "statement_b": f"(Ch {c['b'].get('chapter')}) {c['b'].get('quote')}"}, {"real_contradiction": {
                    "type": "noul",
                    "instructions": "Do these two statements genuinely contradict each other, rather than describe different things/times?",
                    "criteria": {"true": "Both cannot be true at the same time about the same thing",
                                 "false": "They describe different things, times, scopes or are merely rounding/wording differences"}}}, timeout=10)
    return None if a is None else a["real_contradiction"]["noul"]


def iter_reader_stops():
    """Yield (run_label, persona, chapter, quote) for every non-null stop_at."""
    for path in sorted(glob.glob(os.path.join(QA, "literary_runs", "2026*.json"))):
        if os.path.basename(path).startswith("patch_"):
            continue
        d = json.load(open(path))
        for k, v in d.get("raw", {}).items():
            m = re.match(r"reader\|(.+)$", k)
            if not m or not isinstance(v, dict):
                continue
            for ch, row in (v.get("chapters") or {}).items():
                q = row.get("stop_at")
                if q:
                    yield (os.path.basename(path), m.group(1), ch, q)
    for path in sorted(glob.glob(os.path.join(QA, "chapter_briefs", "ch*_regrade_run*.json"))):
        d = json.load(open(path))
        m = re.match(r"ch(\d+)_", os.path.basename(path))
        ch = m.group(1) if m else "?"
        for k, v in d.items():
            m2 = re.match(r"reader\|(.+)$", k)
            if m2 and isinstance(v, dict) and v.get("stop_at"):
                yield (os.path.basename(path), m2.group(1), "Chapter " + ch, v["stop_at"])


def g1_contradictions():
    paths = sorted(glob.glob(os.path.join(QA, "literary_runs", "2026*.json")))
    paths = [p for p in paths if not os.path.basename(p).startswith("patch_")]
    newest = paths[-1]
    d = json.load(open(newest))
    seen, out = set(), []
    for k, v in d.get("raw", {}).items():
        if not k.startswith("facts|"):
            continue
        for c in v.get("contradictions") or []:
            topic = c.get("fact", "")
            a, b = c.get("a", {}), c.get("b", {})
            key = (topic, a.get("quote"), b.get("quote"))
            if key in seen:
                continue
            seen.add(key)
            out.append({"topic": topic, "a": a, "b": b})
    return newest, out


def known_ids(c, queue_lines, use_jev=True):
    """N1: Jev noul `matches_queue_row` per pre-filtered queue row (>= 1 shared keyword) replaces the
    old >=2-shared-words match. Bands: p >= 0.8 -> matched; 0.5-0.8 -> matched + FLAG;
    p < 0.5 or Jev unavailable -> today's keyword behaviour + UNCHECKED.
    Returns (ids, uncertain) — uncertain marks rows decided by the keyword fallback."""
    words = [w for w in re.findall(r"[a-z]{4,}", c["topic"].lower())]

    def row_id(line):
        m = re.match(r"\|\s*(B\d+)\s*\|", line)
        return m.group(1) if m else None

    def kw_match(min_words):
        out = []
        for l in queue_lines:
            if sum(1 for w in words if w in l.lower()) >= min_words:
                rid = row_id(l)
                if rid:
                    out.append(rid)
        return out

    if not use_jev:
        return kw_match(2), True

    cand = " · ".join(filter(None, [c["topic"],
                                    f"Version A (Ch {c['a'].get('chapter')}): {c['a'].get('quote')}",
                                    f"Version B (Ch {c['b'].get('chapter')}): {c['b'].get('quote')}"]))
    pre = [l for l in queue_lines if any(w in l.lower() for w in words)]
    hits, flags, fallback = [], [], False
    for line in pre:
        rid = row_id(line)
        if not rid:
            continue
        a = decide({"candidate": cand, "queue_row": line}, {"matches_queue_row": {
            "type": "noul",
            "instructions": "Is the candidate contradiction about the same underlying fact as this existing review-queue row?",
            "criteria": {"true": "The same fact is stated in both places (a row already tracks this contradiction)",
                         "false": "Different facts that merely share vocabulary"}}}, timeout=10)
        if a is None or a["matches_queue_row"]["noul"] < 0.5:
            fallback = True
            continue
        p = a["matches_queue_row"]["noul"]
        hits.append(rid)
        if p < 0.8:
            flags.append(rid)
    if fallback:
        return kw_match(2), True
    return hits, False


def main():
    queue_lines = open(QUEUE, encoding="utf-8").read().splitlines()
    use_jev = "--no-jev" not in sys.argv

    stops = list(iter_reader_stops())
    themes, theme_src = {}, {}
    words = CHAPTERS
    for run, persona, ch, quote in stops:
        ch = str(ch).replace("Chapter ", "").strip()
        ch = words[int(ch) - 1] if ch.isdigit() and 0 < int(ch) <= len(words) else ch
        if use_jev:
            t, p, via = classify_jev(quote)
        else:
            t, p, via = classify(quote), None, "keyword"
        themes.setdefault(t, []).append(
            {"run": run, "persona": persona, "chapter": ch, "quote": quote}
        )
        theme_src.setdefault(t, set()).add(via)

    signals = []
    for t, rows in sorted(themes.items()):
        if t == "other" or len(rows) < 3:
            continue
        if len({r["chapter"] for r in rows}) >= 2 or len({r["persona"] for r in rows}) >= 2:
            signals.append((t, rows))

    newest, conds = g1_contradictions()
    known, new, dismissed = [], [], []
    for c in conds:
        p = triage_jev(c) if use_jev else None
        c["jev_p"] = p
        if p is not None and p < 0.5:
            dismissed.append((c, p))
            continue
        if p is not None and p < 0.8:
            c["jev_flag"] = True  # 0.5-0.8: act (keep in the normal flow) and FLAG for the founder
        ids, uncertain = known_ids(c, queue_lines, use_jev)
        c["jev_uncertain"] = uncertain
        (known if ids else new).append((c, ids))

    lines = []
    lines.append("# Creator queue proposals (auto-generated by scripts/premise_router.py)")
    lines.append("")
    lines.append("Proposals only. Nothing here edits `duane_review_queue.md`; the creator")
    lines.append("decides what to adopt. Sources: `qa/literary_runs/2026*.json` (reader")
    lines.append("persona stops) and the newest run's G1 contradiction candidates.")
    lines.append("")
    lines.append("## A. Reader-stop theme clusters flagged as premise signals")
    lines.append("")
    lines.append("Rule: >= 3 stops of the same theme, spanning >= 2 chapters or >= 2 personas.")
    lines.append("Theme classification: Jev choice over theme names + 'other'; keyword fallback when "
                 "Jev is down or top p < 0.5." if use_jev else
                 "Theme classification: keyword classifier (Jev off, --no-jev).")
    lines.append("")
    if signals:
        lines.append("| Theme | Classified via | Stops | Chapters | Personas | Sample quotes (up to 3) |")
        lines.append("|---|---|---|---|---|---|")
        for t, rows in signals:
            chapters = ", ".join(sorted({r["chapter"] for r in rows}))
            personas = ", ".join(sorted({r["persona"] for r in rows}))
            via = " + ".join(sorted(theme_src.get(t, {"keyword"})))
            samples = " · ".join(
                '"' + r["quote"][:90] + '" (' + r["chapter"] + ", " + r["persona"] + ")"
                for r in rows[:3]
            )
            lines.append(f"| {t} | {via} | {len(rows)} | {chapters} | {personas} | {samples} |")
    else:
        lines.append("(none)")
    lines.append("")
    lines.append("## B. NEW contradiction candidates (not matched to an existing queue row)")
    lines.append("")
    if new:
        for c, _ in new:
            mark = f" (jev p={c['jev_p']:.2f}, FLAG 0.5-0.8 band)" if c.get("jev_flag") else \
                   f" (jev p={c['jev_p']:.2f})" if c.get("jev_p") is not None else " (UNCHECKED — Jev unavailable)" if use_jev else ""
            if c.get("jev_uncertain"):
                mark += " (UNCHECKED — keyword fallback for known-id match)"
            lines.append(f"- **{c['topic']}**{mark}")
            lines.append(f"  - Version A (Ch {c['a'].get('chapter')}): \"{c['a'].get('quote')}\"")
            lines.append(f"  - Version B (Ch {c['b'].get('chapter')}): \"{c['b'].get('quote')}\"")
    else:
        lines.append("(none)")
    lines.append("")
    lines.append(f"## C. KNOWN contradictions (already in duane_review_queue.md; ids only)")
    lines.append("")
    lines.append(f"Source run: `{newest}`")
    for c, ids in known:
        mark = f" (jev p={c['jev_p']:.2f}, FLAG 0.5-0.8 band)" if c.get("jev_flag") else \
               f" (jev p={c['jev_p']:.2f})" if c.get("jev_p") is not None else " (UNCHECKED — Jev unavailable)" if use_jev else ""
        if c.get("jev_uncertain"):
            mark += " (UNCHECKED — keyword fallback for known-id match)"
        lines.append(f"- {', '.join(ids)} — {c['topic']}{mark}")
    lines.append("")
    lines.append("## D. Dismissed (Jev triage p < 0.5 — likely NOT real contradictions)")
    lines.append("")
    if dismissed:
        for c, p in dismissed:
            lines.append(f"- **{c['topic']}** (jev p={p:.2f})")
            lines.append(f"  - Version A (Ch {c['a'].get('chapter')}): \"{c['a'].get('quote')}\"")
            lines.append(f"  - Version B (Ch {c['b'].get('chapter')}): \"{c['b'].get('quote')}\"")
    else:
        lines.append("(none)")
    lines.append("")

    out_label = os.path.relpath(OUT, os.getcwd())
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"wrote {out_label}: {len(stops)} stops, {len(signals)} premise signals, "
          f"{len(new)} NEW + {len(known)} KNOWN + {len(dismissed)} dismissed(Jev) contradictions")


if __name__ == "__main__":
    main()
