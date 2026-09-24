"""Gate CROSSREF (Phase M, layer M3 accuracy): every place the book talks about its own structure must
match the real chapter order and titles. Run after any chapter is added, split, merged or reordered.

Two layers:
  1. Deterministic: counted claims ("after six chapters", "the first three chapters") must equal the
     chapter's real position; "chapter <N>" must name an existing chapter.
  2. Jev (scripts/jev.py), only for references a regex can't resolve ("chapter five is about X",
     "the crash chapter", "the next chapter"): it is asked whether the named/implied target chapter
     really covers what the sentence says. If Jev is unavailable, those rows are reported UNCHECKED
     (never silently passed).

Usage: python3 scripts/crossref_check.py [--no-jev]  -> <QA>/crossref_report.md; exit 1 on FAIL.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import MS as MS_PATH, QA as QA_DIR  # noqa: E402
from jev import decide  # noqa: E402

MS = MS_PATH.read_text()
OUT = QA_DIR / "crossref_report.md"
WORDS = "one two three four five six seven eight nine ten".split()
WORD_NUM = {w: i + 1 for i, w in enumerate(WORDS)}
# Jev noul bands (engine_workflow): >= HI act automatically, LO-HI act + FLAG,
# < LO fail / don't act. Confidence gate: choice answers with top p < LO are UNCHECKED.
LO, HI = 0.5, 0.8

heads = [(m.start(), m.group(1), m.group(2)) for m in re.finditer(r'#chaphead\("Chapter (\w+)", "\d+", "([^"]+)"', MS)]
end = MS.find("// BACK COVER") if "// BACK COVER" in MS else len(MS)
chapters = []
for i, (s, name, title) in enumerate(heads):
    e = heads[i + 1][0] if i + 1 < len(heads) else end
    text = re.sub(r"`[^`]*`\{=typst\}|#\w+\([^)]*\)|[\[\]]|```\{=typst\}|```", " ", MS[s:e])
    chapters.append({"name": name, "n": WORD_NUM[name.lower()], "title": title, "start": s, "end": e,
                     "text": re.sub(r"\s+", " ", text)})


def best_window(sent, text, w=900):
    """The target passage most about the reference: max overlap of the sentence's key words."""
    keys = {k for k in re.findall(r"[a-z]{5,}", sent.lower())} - {"chapter", "about", "there", "which", "their"}
    best, bi = -1, 0
    for i in range(0, max(1, len(text) - w), 150):
        n = sum(1 for k in keys if k in text[i:i + w].lower())
        if n > best:
            best, bi = n, i
    return text[bi:bi + w]


def chapter_at(pos):
    return next(c for c in chapters if c["start"] <= pos < c["end"])


def line_of(pos):
    return MS.count("\n", 0, pos) + 1


def sentence(pos):
    a = max(MS.rfind(". ", 0, pos), MS.rfind("\n\n", 0, pos)) + 1
    b = MS.find(". ", pos)
    return re.sub(r"\s+", " ", MS[a:b + 1 if b > 0 else pos + 160]).strip()[:300]


rows = []
use_jev = "--no-jev" not in sys.argv
body = MS[chapters[0]["start"]:end]
off = chapters[0]["start"]
for m in re.finditer(r"\b(after|in|across|over|by) (one|two|three|four|five|six|seven|eight|nine|ten) chapters\b", body, re.I):
    pos = off + m.start(); ch = chapter_at(pos); n = WORD_NUM[m.group(2).lower()]
    ok = n == ch["n"] - 1 if m.group(1).lower() in ("after", "by") else n <= len(chapters)
    rows.append((ch["name"], line_of(pos), m.group(0), "count", "PASS" if ok else f"FAIL: chapter {ch['n']} has {ch['n'] - 1} chapters before it", sentence(pos)))
for m in re.finditer(r"\bchapter (one|two|three|four|five|six|seven|eight|nine|ten)\b(?! ?\")", body, re.I):
    pos = off + m.start(); ch = chapter_at(pos); tgt = next(c for c in chapters if c["n"] == WORD_NUM[m.group(1).lower()])
    rows.append((ch["name"], line_of(pos), m.group(0), "named", ("jev", tgt), sentence(pos)))
for m in re.finditer(r"\bthe (next|previous|last|final|[a-z-]+) chapter\b", body, re.I):
    if m.group(1).lower() in ("this", "each", "every", "same", "one"):
        continue
    pos = off + m.start(); ch = chapter_at(pos); k = m.group(1).lower()
    if k == "next":
        tgt = next((c for c in chapters if c["n"] == ch["n"] + 1), None)
    elif k in ("previous", "last"):
        tgt = next((c for c in chapters if c["n"] == ch["n"] - 1), None)
    else:
        tgt = None  # descriptive ("the crash chapter"): Jev picks the chapter
    rows.append((ch["name"], line_of(pos), m.group(0), "implied", ("jev", tgt), sentence(pos)))

out = []
for ch, ln, ref, kind, res, sent in rows:
    if isinstance(res, tuple):
        tgt = res[1]
        if not use_jev:
            res = "UNCHECKED (Jev off)"
        elif tgt is None:
            a = decide({"reference": sent, "chapters": {c["title"]: c["text"][:400] for c in chapters}},
                       {"target": {"type": "choice", "instructions": "Which chapter does the reference point to?",
                                   "criteria": {c["title"]: c["text"][:120] for c in chapters}}})
            if a is None:
                res = "UNCHECKED (Jev unavailable)"
            else:
                t = a["target"].get("choice"); p = max((a["target"].get("probabilities") or {"": 1}).values())
                if p < LO:
                    res = "UNCHECKED (choice p<0.5)"
                else:
                    ok = t != chapters[[c["name"] for c in chapters].index(ch)]["title"]
                    res = f"{'PASS' if ok else 'FAIL'}: -> '{t}' (p={p:.2f})" + (" FLAG" if p < HI else "")
        else:
            a = decide({"reference": sent, "target_title": tgt["title"], "target_passage": best_window(sent, tgt["text"])},
                       {"matches": {"type": "noul", "instructions": "Does the target chapter really cover what the reference sentence says it covers?",
                                    "criteria": {"true": "the target matches the reference", "false": "the reference describes something else"}}})
            if a is None:
                res = "UNCHECKED (Jev unavailable)"
            else:
                p = a["matches"]["noul"]
                band = "PASS" if p >= HI else ("PASS+FLAG" if p >= LO else "FAIL")
                res = f"{band}: -> Ch {tgt['name']} '{tgt['title']}' (p={p:.2f})"
    out.append(f"| {ch} | {ln} | {ref} | {kind} | {res} | {sent.replace('|', '/')} |")

fails = sum("FAIL" in o for o in out)
OUT.write_text("# CROSSREF — the book's references to its own structure\n\n"
               f"Chapters: {', '.join(c['name'] + ' ' + repr(c['title']) for c in chapters)}\n\n"
               "| Chapter | Line | Reference | Kind | Result | Sentence |\n|---|---|---|---|---|---|\n" + "\n".join(out) + "\n")
print(f"CROSSREF: {'FAIL' if fails else 'PASS'} ({fails} failing of {len(out)}) -> {OUT}")
sys.exit(1 if fails else 0)
