#!/usr/bin/env python3
"""Re-grade one revised chapter against its previous version (layer D, pairwise) — ADR 0044.
Usage: chapter_regrade.py Five <before_manuscript.md>
- absolute grades: same 3-judge panel on the new text (median)
- pairwise: each judge compares OLD vs NEW per dimension, in BOTH orders (position-bias control)
- readers: the 3 personas re-read the chapter (previous chapter given as context)
Writes qa/chapter_briefs/ch<N>_regrade.md + .html and a json next to it.
"""
import json, re, statistics, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from literary_panel import DIMS, JUDGES, PERSONAS, READER, BOOK, ANCHORS, call, judge_prompt, gi, gname, prose  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
QA = REPO / "data/intel/duane_book/qa"
NUM = "One Two Three Four Five Six Seven Eight Nine Ten".split()


def chapter_text(ms, n):
    marks = [(m.start(), m.group(1), m.group(2)) for m in re.finditer(r'#chaphead\("Chapter (\w+)", "\d+", "([^"]+)"', ms)]
    for i, (s, name, t) in enumerate(marks):
        if name == n:
            return t, prose(ms[s:(marks[i + 1][0] if i + 1 < len(marks) else (ms.find('// BACK COVER') if '// BACK COVER' in ms else len(ms)))])


def pair_prompt(n, t, first, second):
    dims = ", ".join(DIMS)
    return f"""You are a senior nonfiction editor. {BOOK}
Two versions of Chapter {n}, "{t}", follow: VERSION 1 and VERSION 2. {ANCHORS}
For each dimension ({dims}) say which version is better: "1", "2" or "tie". Judge quality, not length.
Return JSON only: {{"dims": {{"<dimension>": "1|2|tie"}}, "overall": "1|2|tie", "why": "<= 40 words"}}

VERSION 1:
{first}

VERSION 2:
{second}"""


def reader_prompt(persona, prev, n, t, text):
    return f"""You are {persona}. {BOOK} You just read the previous chapter (below, for context) and now read Chapter {n}, "{t}".
Report honestly as this reader about Chapter {n} only: engagement 1-5; would you stop reading (and at which sentence, verbatim <= 15 words, or null); what felt repetitive (or null); one thing you would actually do tomorrow (or 'nothing').
Return JSON only: {{"engagement": 4, "stop_at": null, "repetitive": null, "do_tomorrow": "..."}}

PREVIOUS CHAPTER (context):
{prev}

CHAPTER {n}:
{text}"""


def main():
    n, before = sys.argv[1], Path(sys.argv[2])
    new_ms, old_ms = (REPO / "manuscript/book/manuscript.md").read_text(), before.read_text()
    t, new = chapter_text(new_ms, n)
    _, old = chapter_text(old_ms, n)
    _, prev = chapter_text(new_ms, NUM[NUM.index(n) - 1])
    jobs = {("abs", j): (j, judge_prompt(n, t, new)) for j in JUDGES}
    for j in JUDGES:
        jobs[("pair", j, "old-first")] = (j, pair_prompt(n, t, old, new))
        jobs[("pair", j, "new-first")] = (j, pair_prompt(n, t, new, old))
    for p, d in PERSONAS.items():
        jobs[("reader", p)] = (READER, reader_prompt(d, prev, n, t, new))
    with ThreadPoolExecutor(6) as ex:
        res = {k: f.result() for k, f in {k: ex.submit(call, m, pr) for k, (m, pr) in jobs.items()}.items()}
    # prior grades from the brief's run
    run = json.loads(sorted((QA / "literary_runs").glob("2026*.json"))[-1].read_text())["raw"]
    patch = QA / "literary_runs/patch_1.json"
    if patch.exists():
        run.update({k: v for k, v in json.loads(patch.read_text()).items() if "_error" not in v})
    L = [f"# Re-grade — Chapter {n} (revision vs previous version)", "",
         "| Dimension | Before (median) | After (median) | Pairwise: NEW better / OLD better / tie (6 votes, both orders) |", "|---|---|---|---|"]
    wins_total = [0, 0, 0]
    for d in DIMS:
        b = [gi(((run.get(f"judge|{n}|{j}") or {}).get("dims") or {}).get(d, {}).get("grade")) for j in JUDGES]
        a = [gi(((res[("abs", j)].get("dims") or {}).get(d) or {}).get("grade")) for j in JUDGES]
        b, a = [x for x in b if x is not None], [x for x in a if x is not None]
        w = [0, 0, 0]
        for j in JUDGES:
            for order in ("old-first", "new-first"):
                v = str(((res[("pair", j, order)].get("dims") or {}).get(d)) or "tie")
                new_is = "2" if order == "old-first" else "1"
                w[0 if v == new_is else (2 if v == "tie" else 1)] += 1
        wins_total = [x + y for x, y in zip(wins_total, w)]
        L.append(f"| {d} | {gname(statistics.median(b)) if b else '—'} | **{gname(statistics.median(a)) if a else '—'}** | {w[0]} / {w[1]} / {w[2]} |")
    ob = statistics.median([statistics.median([gi(((run.get(f'judge|{n}|{j}') or {}).get('dims') or {}).get(d, {}).get('grade')) or 0 for j in JUDGES]) for d in DIMS])
    oa = statistics.median([statistics.median([gi(((res[('abs', j)].get('dims') or {}).get(d) or {}).get('grade')) or 0 for j in JUDGES]) for d in DIMS])
    L += ["", f"**Chapter overall: {gname(ob)} → {gname(oa)}** · pairwise totals: NEW better {wins_total[0]}, OLD better {wins_total[1]}, tie {wins_total[2]}", "",
          "## Overall pairwise verdicts", ""]
    for j in JUDGES:
        for order in ("old-first", "new-first"):
            r = res[("pair", j, order)]
            ov = str(r.get("overall"))
            winner = "NEW" if ov == ("2" if order == "old-first" else "1") else ("tie" if ov == "tie" else "OLD")
            L.append(f"- {j.split(':')[1].split('/')[-1]} ({order}): **{winner}** — {r.get('why', r.get('_error', ''))}")
    L += ["", "## Readers on the revised chapter", "", "| Reader | Engagement (before → after) | Would stop at | Felt repetitive | Would do tomorrow |", "|---|---|---|---|---|"]
    for p in PERSONAS:
        before_r = ((run.get(f"reader|{p}") or {}).get("chapters") or {}).get(n) or {}
        r = res[("reader", p)]
        L.append(f"| {p} | {before_r.get('engagement','—')} → **{r.get('engagement','—')}** | {r.get('stop_at') or '—'} | {r.get('repetitive') or '—'} | {r.get('do_tomorrow') or '—'} |")
    L += ["", "## G2 credibility after revision", ""] + [f"- {j.split(':')[1].split('/')[-1]}: {'PASS' if (res[('abs', j)].get('G2') or {}).get('pass') else 'FAIL'} — {'; '.join((res[('abs', j)].get('G2') or {}).get('issues') or [])[:200]}" for j in JUDGES]
    errs = [f"{k}: {v['_error']}" for k, v in res.items() if isinstance(v, dict) and "_error" in v]
    if errs:
        L += ["", "## Errors", ""] + [f"- {e}" for e in errs]
    out = QA / "chapter_briefs" / f"ch{NUM.index(n) + 1}_regrade.md"
    out.write_text("\n".join(L))
    (out.with_suffix(".json")).write_text(json.dumps({"|".join(k): v for k, v in res.items()}, indent=1, ensure_ascii=False))
    subprocess.run([str(REPO / ".tools/pandoc/bin/pandoc"), "-f", "markdown-yaml_metadata_block", str(out), "-s", "--metadata",
                    f"title=Re-grade — Chapter {n}", "--embed-resources", "--css", str(QA / "report.css"), "-o", str(out.with_suffix(".html"))], check=False)
    print("\n".join(L))


if __name__ == "__main__":
    main()
