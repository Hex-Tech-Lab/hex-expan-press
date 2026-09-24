#!/usr/bin/env python3
"""Misheard-numbers check (T37-W1c, G6): scans transcripts for numbers that are probably
speech-to-text errors (fifteen vs fifty, inconsistent with surrounding numbers).

For every transcript file under --dir (default data/db/samples/duane_retirearly500/transcripts/),
splits text into sentences, finds every spoken number (digits and number words), and asks Jev noul
`likely_misheard` given the sentence and the neighbouring 2 sentences. Results are cached per
file+sentence hash in <QA>/jev_cache_transcripts.json. Report FLAG >= 0.5 with file:line ->
<QA>/transcript_numbers_report.md + rendered .html. Reports only — never edits anything.

Usage: python3 scripts/transcript_numbers_check.py [--dir <dir>] [--limit N] [--no-jev]
"""
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA  # noqa: E402
from jev import decide  # noqa: E402

LO = 0.5
SAVE_EVERY = 200
DEFAULT_DIR = "data/db/samples/duane_retirearly500/transcripts/"
NUM_RE = re.compile(
    r"\$?\d[\d,.]*%?|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
    r"fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|"
    r"eighty|ninety|hundred|thousand|million|billion)\b", re.I)
SENT_RE = re.compile(r"(?<=[.!?])\s+|\n+")
Q = {"likely_misheard": {"type": "noul",
    "instructions": "Is this number probably a speech-to-text error, e.g. fifteen vs fifty, or "
                    "inconsistent with the surrounding numbers in the passage?",
    "criteria": {"true": "The number is probably an STT mishearing or inconsistent with neighbours.",
                 "false": "The number looks correct and consistent."}}}


FIN_CTX = re.compile(r"\$|percent|%|dollar|thousand|million|grand|\bk\b|a month|a year|per month|per year|"
                     r"years? old|\bage\b|withdraw|portfolio|balance|salary|income|budget|rate|return|401|ira|"
                     r"social security|pension|savings|expenses|cost", re.I)


def is_financial(num, sentence):
    """Only numbers the book could cite: money, percentages, years, ages, amounts. Skips clock times
    ("3:00"), bare pronoun "one" and counting words with no money/age context (2026-09-24 noise fix)."""
    if re.search(re.escape(num) + r"\s*(?::\d\d|\s*(?:am|pm|o'clock))", sentence, re.I) or re.search(r"\d:\s*" + re.escape(num.strip(".")), sentence):
        return False
    if num.lower() in ("one", "ones", "once"):
        return False
    if re.fullmatch(r"(?:19|20)\d\d", num.strip(".,")):
        return True
    return bool(FIN_CTX.search(sentence))


def main():
    argv = sys.argv[1:]
    use_jev = "--no-jev" not in argv
    ddir = next((a.split("=", 1)[1] for a in argv if a.startswith("--dir=")),
                argv[argv.index("--dir") + 1] if "--dir" in argv else DEFAULT_DIR)
    m = re.search(r"--limit[= ](\d+)", " ".join(argv))
    limit = int(m.group(1)) if m else None
    root = Path(ddir)
    cache_path = QA / "jev_cache_transcripts.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    rows, jobs, asked = [], [], 0
    for f in sorted(root.iterdir()):
        if f.suffix == ".vtt" and f.with_suffix("").with_suffix(".txt").exists() or f.suffix == ".vtt" and (f.parent / (f.name.split(".")[0] + ".txt")).exists():
            continue  # the plain .txt of the same video reads in whole sentences; don't double-count
        if f.suffix not in (".txt", ".vtt"):
            continue
        text = f.read_text(errors="replace")
        # WebVTT: strip timestamps/headers so line numbers map onto the raw file loosely.
        vtt = f.suffix == ".vtt"
        body = re.sub(r"(?m)^(?:WEBVTT.*|\d{2}:\d{2}:.*-->.*|NOTE.*)$", "", text) if vtt else text
        lines = body.splitlines()
        if vtt:  # strip inline cue tags (<00:00:01.840>, <c>, </c>, align/position settings) and rolling duplicates
            clean, prev = [], None
            for ln in lines:
                c = re.sub(r"<[^>]*>", "", ln)
                c = re.sub(r"\s+(?:align|position|line|size):\S+", "", c).strip()
                clean.append("" if c == prev else c)
                prev = c or prev
            lines = clean
            body = "\n".join(lines)
        offset = len(text[:len(text[:text.find(body) if vtt else 0] or "")].splitlines()) if vtt else 0
        sents, spans = [], []
        for m2 in re.finditer(r"[^\n.!?]+(?:[.!?]+|\n|$)", body):
            s = m2.group(0).strip()
            if s and NUM_RE.search(s):
                ln = body[:m2.start()].count("\n") + 1 + offset
                sents.append((s, ln))
        for idx, (s, ln) in enumerate(sents):
            if s.lstrip().startswith("#"):
                continue  # headings (video id / title), not speech
            nums = [n for n in NUM_RE.findall(s) if is_financial(n, s)]
            if not nums:
                continue
            ctx = " ".join(x[0] for x in sents[max(0, idx - 2):idx + 3])
            key = hashlib.sha1((str(f) + "|" + ctx).encode()).hexdigest()
            for num in nums[:3]:
                if limit is not None and asked >= limit:
                    break
                asked += 1
                jobs.append((key + "|" + num.lower(), f.name, ln, num, s, ctx))
        if limit is not None and asked >= limit:
            break

    # Ask phase: 8 parallel Jev calls, cache saved every SAVE_EVERY answers so a killed run keeps its
    # work (2026-09-26: the serial version wrote the cache only at the end and lost a 1h+ run).
    todo = [j for j in jobs if j[0] not in cache]
    print(f"{len(jobs)} numbers in {len({j[1] for j in jobs})} files; {len(jobs) - len(todo)} cached, "
          f"{len(todo)} to ask", flush=True)
    lock, done = threading.Lock(), [0]

    def ask(job):
        ck, _, _, num, s, ctx = job
        a = decide({"number": num, "sentence": s, "context": ctx}, Q, timeout=20)
        p = a["likely_misheard"]["noul"] if a else None
        with lock:
            if p is not None:  # never cache an outage: a rerun must retry it
                cache[ck] = {"p": p, "v": "FLAG" if p >= LO else "PASS"}
            done[0] += 1
            if done[0] % SAVE_EVERY == 0:
                cache_path.write_text(json.dumps(cache, indent=0))
                print(f"  {done[0]}/{len(todo)} asked", flush=True)

    if use_jev and todo:
        with ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(ask, todo))
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, indent=0))
    for ck, name, ln, num, s, _ in jobs:
        if ck in cache:
            p, v = cache[ck]["p"], cache[ck]["v"]
        else:
            p, v = None, "UNCHECKED (Jev off)" if not use_jev else "UNCHECKED (Jev unavailable)"
        rows.append((name, ln, num, s[:110], p, v))
    out = [f"# TRANSCRIPT NUMBERS — misheard check ({root})", ""]
    flags = [r for r in rows if r[5] == "FLAG"]
    unc = sum(r[5].startswith("UNCHECKED") for r in rows)
    for name, ln, num, s, p, v in flags:
        out.append(f"- **FLAG**{'' if p is None else f' (p={p:.2f})'} {name}:{ln} number `{num}`: {s}")
    out += ["", f"Checked {len(rows)} number instances ({len(flags)} FLAG, {unc} UNCHECKED)."]
    rep = QA / "transcript_numbers_report.md"
    rep.write_text("\n".join(out))
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
    print(f"TRANSCRIPT-NUMBERS: {len(rows)} checked, {len(flags)} FLAG, {unc} UNCHECKED -> {rep}")


if __name__ == "__main__":
    main()
