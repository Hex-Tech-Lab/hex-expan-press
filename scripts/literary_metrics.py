#!/usr/bin/env python3
"""Literary QA, layer A: deterministic prose metrics per chapter, part and book (ADR 0044).
Strips Typst/Markdown, then measures the prose. Writes <QA>/literary_metrics.json
and prints a Markdown table.
- burstiness: coefficient of variation of sentence length (human prose ~0.5-0.8; flat AI-like prose < 0.4)
- predictability: gzip compression ratio (a perplexity proxy; lower = more repetitive/predictable)
- fk_grade: Flesch-Kincaid grade level; mattr: moving-average type-token ratio (500-word window)
"""
import json, re, statistics, sys, zlib
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import MS as MS_PATH, QA, CHAPTERS  # noqa: E402

MS = MS_PATH.read_text()
OUT = QA / "literary_metrics.json"
# Part structure comes from the manuscript's #partpage markers (book_config.parts); never assumed.
from book_config import PARTS  # noqa: E402


def prose(block):
    block = re.sub(r'#dropcap\("(\w)"[^)]*\)\[', r"[\1", block)  # rejoin the drop-cap letter, else judges read "o what" as a typo
    t = re.sub(r"```\{=typst\}\n(.*?)```", lambda m: " ".join(re.findall(r"\[([^\[\]#]{20,})", m.group(1))), block, flags=re.S)
    t = re.sub(r"```\{=typst\}(?:(?!```).)*$", "", t, flags=re.S)  # unclosed fence at the slice end (leaked "` #oddbreak")
    t = re.sub(r"^\s*#[A-Za-z_]\w*.*$", "", t, flags=re.M)        # bare Typst command lines (#oddbreak, #orn, ...)
    t = re.sub(r"\\u\{201[CD]\}", '"', t)
    t = re.sub(r"\\u\{[0-9A-Fa-f]+\}", "", t)
    t = t.replace("\\$", "$").replace("\\_", "_")
    t = re.sub(r"^#+ .*$", "", t, flags=re.M)
    t = re.sub(r"`[^`]*`\{=typst\}|#\w+\([^)]*\)", "", t)
    return re.sub(r"\s+", " ", t.replace("```", "")).strip()


def syllables(w):
    w = w.lower()
    n = len(re.findall(r"[aeiouy]+", w))
    return max(1, n - (1 if w.endswith("e") and n > 1 else 0))


def metrics(text):
    sents = [s for s in re.split(r"(?<=[.!?])\s+(?=[A-Z\"$0-9])", text) if len(s.split()) > 1]
    words = re.findall(r"[A-Za-z']+", text)
    lens = [len(s.split()) for s in sents]
    lw = [w.lower() for w in words]
    win = 500
    mattr = statistics.mean(len(set(lw[i:i + win])) / win for i in range(0, max(1, len(lw) - win), 50)) if len(lw) > win else len(set(lw)) / max(1, len(lw))
    grams = Counter(" ".join(lw[i:i + 4]) for i in range(len(lw) - 3))
    raw = text.encode()
    return {
        "words": len(words),
        "sentences": len(sents),
        "sent_len_mean": round(statistics.mean(lens), 1) if lens else 0,
        "burstiness": round(statistics.pstdev(lens) / statistics.mean(lens), 2) if len(lens) > 1 else 0,
        "predictability": round(len(zlib.compress(raw, 9)) / len(raw), 3),
        "fk_grade": round(0.39 * len(words) / max(1, len(sents)) + 11.8 * sum(map(syllables, words)) / max(1, len(words)) - 15.59, 1),
        "mattr": round(mattr, 3),
        "quotes_per_1k": round(1000 * text.count('"') / 2 / max(1, len(words)), 1),
        "numbers_per_1k": round(1000 * len(re.findall(r"\$?\d[\d,.]*%?", text)) / max(1, len(words)), 1),
        "sources_per_1k": round(1000 * len(re.findall(r"\b(study|survey|report|according to|Vanguard|Fidelity|Federal Reserve|Morningstar|Bengen|Census|SSA|Social Security Administration|Bureau|Journal|Review)\b", text)) / max(1, len(words)), 1),
        "repeated_4grams": [g for g, c in grams.most_common(8) if c >= 3],
    }


def main():
    from book_config import chapter_sources
    chapters = {n: prose(src) for n, _, src in chapter_sources(MS)}
    res = {"chapters": {n: metrics(t) for n, t in chapters.items()},
           "parts": {p: metrics(" ".join(chapters[c] for c in cs if c in chapters)) for p, cs in PARTS.items()},
           "book": metrics(" ".join(chapters.values()))}
    OUT.write_text(json.dumps(res, indent=1))
    cols = ["words", "sent_len_mean", "burstiness", "predictability", "fk_grade", "mattr", "quotes_per_1k", "numbers_per_1k", "sources_per_1k"]
    print("| Unit | " + " | ".join(cols) + " |\n|" + "---|" * (len(cols) + 1))
    for name, m in [(f"Ch {n}", m) for n, m in res["chapters"].items()] + [(f"Part {p}", m) for p, m in res["parts"].items()] + [("BOOK", res["book"])]:
        print(f"| {name} | " + " | ".join(str(m[c]) for c in cols) + " |")


if __name__ == "__main__":
    main()
