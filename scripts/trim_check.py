"""Jev gate for wording trims (Phase M, layer M3c): every proposed trim must keep the meaning and
drop no fact. Reads a trims.json ({id, old, new, ...}); sends Jev only the two spans.

    python3 scripts/trim_check.py data/intel/duane_book/qa/trim/ch4/trims.json

Bands (engine_workflow): p >= 0.8 ACCEPT, 0.5-0.8 FLAG (accept, list for the founder),
< 0.5 or Jev unavailable REJECT/UNCHECKED. Exit 1 if any trim is rejected or unchecked.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jev import decide  # noqa: E402

MS = Path(__file__).resolve().parent.parent / "manuscript/book/manuscript.md"

QUESTIONS = {
    "meaning_kept": {"type": "noul",
                     "instructions": "An editor tightened a memoir passage. Judge like a careful editor: does AFTER keep "
                                     "the substance of BEFORE (same claims, advice, examples and tone)? Dropping "
                                     "redundant phrases, intensifiers or filler words is fine and still counts as kept.",
                     "criteria": {"true": "Substance and voice preserved; only wordiness removed.",
                                  "false": "A claim, piece of advice, example, joke or nuance that matters is gone or changed."}},
    "drops_fact": {"type": "noul",
                   "instructions": "Is any concrete fact in BEFORE (number, date, dollar amount, name, place, "
                                   "quantity, sequence of events) missing or altered in AFTER?",
                   "criteria": {"true": "At least one concrete fact is missing or altered.",
                                "false": "Every concrete fact survives unchanged."}},
}


def plain(s):
    """Strip Typst escapes/markup so Jev sees prose."""
    s = re.sub(r"`#h\(\d+pt\)`\{=typst\}|#h\(\d+pt\)", "", s)
    return re.sub(r"\s+", " ", s.replace("\\$", "$").replace("\\_", "_")).strip()


def main(path):
    trims = json.loads(Path(path).read_text())
    ms = MS.read_text()
    worst = 0
    for t in trims:
        n = ms.count(t["old"])
        if n != 1:
            print(f"REJECT {t['id']}: `old` occurs {n}x in manuscript.md")
            worst = 2
            continue
        a = decide({"before": plain(t["old"]), "after": plain(t["new"])}, QUESTIONS, timeout=20)
        if not a:
            print(f"UNCHECKED {t['id']}: Jev unavailable")
            worst = 2
            continue
        keep, drop = a["meaning_kept"]["noul"], a["drops_fact"]["noul"]
        p = min(keep, 1 - drop)
        verdict = "ACCEPT" if p >= 0.8 else "FLAG" if p >= 0.5 else "REJECT"
        if verdict == "REJECT":
            worst = 2
        t["jev"] = {"meaning_kept": keep, "drops_fact": drop, "verdict": verdict}
        print(f"{verdict} {t['id']}: meaning_kept={keep:.2f} drops_fact={drop:.2f}")
    Path(path).with_name("trims_checked.json").write_text(json.dumps(trims, indent=1))
    sys.exit(1 if worst else 0)


if __name__ == "__main__":
    main(sys.argv[1])
