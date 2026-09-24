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
import re
import subprocess
import sys
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
    flags, moved_n, neigh_n = [], 0, 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k, u in enumerate(nu[j1:j2]):
                oi = i1 + k  # equal blocks preserve order: old index maps positionally
                j = j1 + k
                # old neighbour indices
                prev_o = ou[oi - 1] if oi > 0 else ""
                next_o = ou[oi + 1] if oi + 1 < len(ou) else ""
                prev_n = nu[j - 1] if j > 0 else ""
                next_n = nu[j + 1] if j + 1 < len(nu) else ""
                moved = oi != j
                neigh_changed = moved or prev_o != prev_n or next_o != next_n
                if not neigh_changed:
                    continue
                moved_n += moved
                neigh_n += not moved
                for who, txt in ((u and "self", u), (1, prev_n), (2, next_n)):
                    hits = DEICTIC.findall(txt) if txt else []
                    if not hits:
                        continue
                    chap = chap_of(new, new.find(u) if u else 0)
                    ctx_prev = prev_n[:400]
                    ctx_next = next_n[:400]
                    if args.no_jev:
                        p = None; v = "UNCHECKED (Jev off)"
                    else:
                        a = decide({"paragraph": txt[:900], "preceding_paragraph": ctx_prev,
                                    "following_paragraph": ctx_next}, Q, timeout=20)
                        if a is None:
                            p = None; v = "UNCHECKED (Jev unavailable)"
                        else:
                            p = a["reference_broken"]["noul"]
                            v = "FLAG" if p >= 0.5 else "PASS"
                    flags.append((chap, "self" if who == "self" else ("prev" if who == 1 else "next"),
                                  v, p, ", ".join(hits)[:120], txt[:300]))
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
