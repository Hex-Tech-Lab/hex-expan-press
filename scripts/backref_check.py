#!/usr/bin/env python3
"""Back-reference integrity after paragraph moves (T37-W1b, B7). Compares an old manuscript
(--before path) with the current one; for every paragraph or typst block that MOVED or whose
neighbour changed, finds deictic references in it and in its new neighbours ("below", "above",
"this chapter", "the worksheet", "that", "earlier", "next", "the following") and asks Jev
reference_broken given the paragraph and its new preceding/following paragraph.
p >= 0.5 -> FLAG with the text. Writes <QA>/backref_report.md (+ .html). Never edits the book.

Usage: python3 scripts/backref_check.py --before data/intel/duane_book/qa/revisions/manuscript_2026-09-24_pre-bridges.md [--no-jev]
"""
import argparse
import difflib
import hashlib
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
from book_config import MS, QA  # noqa: E402
from jev import decide  # noqa: E402

DEICTIC = re.compile(
    r"\b(?:below|above|earlier|later|next)\b"
    r"|\bthis chapter\b|\bthe (?:worksheet|table|box|checklist|tool)\b|\bthat\b"
    r"|\bthe following\b|\bprevious\b|\bprevious section\b", re.I)
Q = {"reference_broken": {"type": "noul",
     "instructions": "Given this paragraph and its new preceding/following paragraphs, is a deictic "
                     "reference in it (\"below\", \"above\", \"this chapter\", \"the worksheet\", ...) now "
                     "BROKEN — i.e. the thing it points at is no longer there or is no longer adjacent?",
     "criteria": {"true": "The reference points at something that is no longer present or adjacent.",
                  "false": "Every reference still resolves correctly in the new neighbourhood."}}}


def units(text):
    """Paragraph/block units in reading order: blank-line-separated paragraphs; ```{=typst} fences as
    one unit; bare typst command lines attach to the previous unit."""
    text = text.replace("\r\n", "\n")
    raw, out = text.split("\n\n"), []
    for b in raw:
        b = b.strip()
        if not b:
            continue
        if b.startswith("```") and "```" not in b[3:]:
            out.append(b)
        elif out and not b.startswith("#") and re.match(r"^\\?\s*#[A-Za-z_]", b):
            out[-1] += "\n" + b
        else:
            out.append(b)
    return out


def unit_at(us, i):
    return us[i] if 0 <= i < len(us) else ""


def chap_of(text, idx):
    """Chapter name owning the offset idx in the raw manuscript text."""
    last = None
    for m in re.finditer(r'#chaphead\("Chapter (\w+)"', text):
        if m.start() <= idx:
            last = m.group(1)
        else:
            break
    return last or "front"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True)
    ap.add_argument("--no-jev", action="store_true")
    args = ap.parse_args()
    before = Path(args.before)
    old, new = before.read_text(), MS.read_text()
    ou, nu = units(old), units(new)
    sm = difflib.SequenceMatcher(None, ou, nu, autojunk=False)
    # Index shift after an insertion is NOT a move. A unit is MOVED only when the diff deletes it in one
    # place and inserts the same text elsewhere; any surviving unit is examined only if its actual
    # neighbours changed.
    moved_at = set()  # new-side indices, not texts: an unchanged copy of a repeated unit is never "moved"
    deleted = {u for tag, i1, i2, _, _ in sm.get_opcodes() if tag in ("delete", "replace") for u in ou[i1:i2]}
    first_old = {}
    for i, u in enumerate(ou):
        first_old.setdefault(u, i)
    old_pos = {}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                old_pos[j1 + k] = i1 + k
        elif tag in ("insert", "replace"):
            for j in range(j1, j2):
                if nu[j] in deleted:
                    moved_at.add(j)
                    old_pos[j] = first_old[nu[j]]
    # offset of each new unit found sequentially, so repeated blocks resolve to their own chapter
    offs, pos = [], 0
    for u in nu:
        k = new.find(u, pos)
        offs.append(k if k >= 0 else pos)
        pos = max(pos, k + len(u)) if k >= 0 else pos
    jobs, seen, moved_n, neigh_n = [], set(), 0, 0
    for j, oi in sorted(old_pos.items()):
        u = nu[j]
        prev_n = nu[j - 1] if j > 0 else ""
        next_n = nu[j + 1] if j + 1 < len(nu) else ""
        prev_o = ou[oi - 1] if oi > 0 else ""
        next_o = ou[oi + 1] if oi + 1 < len(ou) else ""
        moved = j in moved_at
        if not moved and prev_o == prev_n and next_o == next_n:
            continue
        moved_n += moved
        neigh_n += not moved
        for who, at in (("self", j), ("prev", j - 1), ("next", j + 1)):
            txt = unit_at(nu, at)
            hits = DEICTIC.findall(txt) if txt else []
            if not hits:
                continue
            chap = chap_of(new, offs[at])
            # context is the checked paragraph's OWN neighbours (for prev/next that includes the moved unit u)
            cp, cn = unit_at(nu, at - 1)[:400], unit_at(nu, at + 1)[:400]
            key = hashlib.sha1(f"{txt[:900]}|{cp}|{cn}".encode()).hexdigest()
            if key in seen:
                continue
            seen.add(key)
            jobs.append((key, chap, who, ", ".join(hits)[:120], txt, cp, cn))

    cache_path = QA / "jev_cache_backref.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    def ask(job):
        key, _, _, _, txt, cp, cn = job
        if args.no_jev:
            return None
        if key in cache:
            return cache[key]
        a = decide({"paragraph": txt[:900], "preceding_paragraph": cp, "following_paragraph": cn}, Q, timeout=20)
        return None if a is None else a["reference_broken"]["noul"]

    with ThreadPoolExecutor(max_workers=8) as ex:
        answers = list(ex.map(ask, jobs))
    flags = []
    for job, p in zip(jobs, answers):
        key, chap, who, hits, txt = job[:5]
        if p is None:
            v = "UNCHECKED (Jev off)" if args.no_jev else "UNCHECKED (Jev unavailable)"
        else:
            cache[key] = p
            v = "FLAG" if p >= 0.5 else "PASS"
        flags.append((chap, who, v, p, hits, txt[:300]))
    cache_path.write_text(json.dumps(cache, indent=0))
    out = ["# BACK-REF CHECK — deictic references after moves (T37-W1b, B7)", ""]
    out.append(f"before={args.before}  current={MS.name}")
    out.append(f"moved units: {moved_n}  neighbour-changed units: {neigh_n}  checked refs: {len(flags)}")
    out.append("")
    n_flag = 0
    for chap, who, v, p, hits, txt in flags:
        n_flag += v == "FLAG"
        out.append(f"- **{v}**{'' if p is None else f' (p={p:.2f})'} Ch{chap} [{who}] refs={hits}: {txt}")
    out.append("")
    out.append(f"TOTAL: {n_flag} FLAG of {len(flags)} checked")
    rep = QA / "backref_report.md"
    rep.write_text("\n".join(out))
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
    print(f"BACKREF: moved={moved_n} neigh={neigh_n} checked={len(flags)} FLAG={n_flag} -> {rep}")


if __name__ == "__main__":
    main()
