#!/usr/bin/env python3
"""Voice check (T37-W1a, A24): Jev `same_voice` gate for author-voice drift.

References: the 6 longest prose paragraphs of Ch3, Ch7 and Ch9 (chapters NOT edited today),
2 per chapter, extracted via book_config.chapter_sources + literary_metrics.prose cleaning.

Paragraphs to check: a --paragraphs file (blank-line separated), or by default the
paragraphs of the current manuscript whose text differs from `--before <old manuscript>`
(new or edited paragraphs).

For each checked paragraph Jev answers noul `same_voice` ("Could the author of the
REFERENCE paragraphs have written this paragraph, in tone, rhythm and vocabulary?").
p < 0.5 -> FLAG. Writes <QA>/voice_report.md (rendered via render_report.sh).
Exit 1 on any FLAG. RULE 0: reports only; never edits the book.

Usage: python3 scripts/voice_check.py [--before <old manuscript>] [--paragraphs <file>] [--no-jev]
"""
import argparse
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA, MS, chapter_sources  # noqa: E402
from jev import decide  # noqa: E402

LO = 0.5
VOICE_Q = {"same_voice": {"type": "noul",
    "instructions": "REFERENCE paragraphs = samples of the author's own voice from the same book. "
                    "Could the author of the REFERENCE paragraphs have written the PARAGRAPH, in tone, "
                    "rhythm and vocabulary?",
    "criteria": {"true": "Tone, rhythm and vocabulary match the reference author's voice.",
                 "false": "It reads like a different writer (wrong register, rhythm or vocabulary)."}}}
REF_CHAPTERS = ["Three", "Seven", "Nine"]
PER_CHAPTER = 2  # 3 chapters x 2 = 6 reference paragraphs
MIN_WORDS = 25


def typst_fences(src):
    for m in re.finditer(r"```\{=typst\}\n(.*?)```", src, re.S):
        yield m.group(1)


def paragraphs(src):
    """Prose paragraphs of a chapter source, blank-line separated, typst fences flattened."""
    t = re.sub(r'#dropcap\("(\w)"[^)]*\)\[', r"[\1", src)
    flat = []
    for f in typst_fences(t):
        items = re.findall(r"\[([^\[\]#]{20,})", f)
        if items:
            flat.append("\n\n".join(items))
        t = t.replace("```{=typst}\n" + f + "```", " @FENCE@ ", 1)
    # drop any unclosed trailing fence
    t = re.sub(r"```\{=typst\}(?:(?!```).)*$", " @FENCE@ ", t, flags=re.S)
    t = re.sub(r"^\s*#[A-Za-z_]\w*.*$", "", t, flags=re.M)
    t = re.sub(r"\\u\{201[CD]\}", '"', t).replace("\\$", "$").replace("\\_", "_")
    t = re.sub(r"^#+ .*$", "", t, flags=re.M)
    t = re.sub(r"`[^`]*`\{=typst\}|#\w+\([^)]*\)", "", t)
    t = t.replace("@FENCE@", "\n\n@FENCE@\n\n")
    out = []
    for p in re.split(r"\n\s*\n", t):
        p = re.sub(r"\s+", " ", p.replace("```", "")).strip().strip("@").strip()
        if len(p.split()) >= MIN_WORDS and "@" not in p and not re.match(r"^\$", p):
            out.append(p)
    return out


def norm(p):
    return re.sub(r"\s+", " ", p.lower().replace("\\$", "$")).strip()


def diff_paragraphs(before_path):
    """Paragraphs of the current manuscript whose text differs from the before manuscript,
    plus pinned paragraphs that the check must always cover (Ch1 three-legs passage,
    Ch10 closing) even if they predate the before manuscript."""
    cur = []
    for name, _, src in chapter_sources():
        cur.extend(paragraphs(src))
    old = Counter(norm(p) for p in paragraphs(Path(before_path).read_text()))
    changed = [p for p in cur if old[norm(p)] == 0]
    pinned_needles = ["second income I never planned", "Five years in,"]
    chosen = list(changed)
    for needle in pinned_needles:
        if not any(needle in p for p in chosen):
            chosen.extend(p for p in cur if needle in p)
    # short typst paragraphs (#takeaway) are below MIN_WORDS; pin the Ch10 closing takeaway raw
    if not any("genuinely happy camper" in p for p in chosen):
        for name, _, src in chapter_sources():
            for m in re.finditer(r"#takeaway\[(.*?)\]", src, re.S):
                txt = re.sub(r"\s+", " ", m.group(1)).strip()
                if txt and "genuinely happy camper" in txt:
                    chosen.append(txt)
    return chosen


def main():
    ap = argparse.ArgumentParser(prog="voice_check.py")
    ap.add_argument("--before", default=None)
    ap.add_argument("--paragraphs", default=None)
    ap.add_argument("--no-jev", action="store_true")
    args = ap.parse_args()

    srcs = dict((n, s) for n, _, s in chapter_sources())
    refs = []
    for name in REF_CHAPTERS:
        ps = sorted(paragraphs(srcs[name]), key=lambda p: -len(p.split()))[:PER_CHAPTER]
        refs.extend(ps)
    if args.paragraphs:
        checked = [p.strip() for p in Path(args.paragraphs).read_text().split("\n\n") if p.strip()]
    elif args.before:
        checked = diff_paragraphs(args.before)
    else:
        print("BLOCKED: need --before <old manuscript> or --paragraphs <file>", file=sys.stderr)
        return 2

    flags, rows = [], []
    for p in checked:
        if not args.no_jev:
            a = decide({"reference_paragraphs": refs, "paragraph": p}, VOICE_Q, timeout=20)
            p_v = a["same_voice"]["noul"] if a and "same_voice" in a else None
        else:
            p_v = None
        verdict = ("PASS" if p_v >= LO else "FLAG") if p_v is not None else "UNCHECKED (Jev off)" if args.no_jev \
            else "UNCHECKED (Jev unavailable)"
        if verdict == "FLAG":
            flags.append(p)
        rows.append((p, p_v, verdict))

    out = ["# VOICE — author-voice match (T37-W1a, A24)", "",
           f"References: {len(refs)} longest paragraphs of Ch" +
           ", Ch".join(REF_CHAPTERS) + f". {len(rows)} paragraphs checked, {len(flags)} FLAG.", "",
           "| paragraph | p | verdict |", "|---|---|---|"]
    for p, pv, verdict in rows:
        out.append(f"| {p.replace('|', chr(92)+'|')[:220]} | {'—' if pv is None else f'{pv:.2f}'} | {verdict} |")
    out.append("")
    if flags:
        out.append("## FLAGS (p < 0.5)")
        out.extend(f"- {f}" for f in flags)
    rep = QA / "voice_report.md"
    rep.write_text("\n".join(out))
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
    print(f"VOICE: {'FAIL' if flags else 'PASS'} ({len(rows)} checked, {len(flags)} FLAG) -> {rep}")
    sys.exit(1 if flags else 0)


if __name__ == "__main__":
    main()
