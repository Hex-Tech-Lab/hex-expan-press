#!/usr/bin/env python3
"""Re-grade one revised chapter against its previous version (layer D, pairwise) — ADR 0044.
Usage: chapter_regrade.py Five <before_manuscript.md> [--no-jev]
- absolute grades: same 3-judge panel on the new text (median)
- pairwise: each judge compares OLD vs NEW per dimension, in BOTH orders (position-bias control)
- readers: the 3 personas re-read the chapter (previous chapter given as context)
Writes qa/chapter_briefs/ch<N>_regrade.md + .html and a json next to it.

Jev gates (T33-J1):
- backup: the manuscript is backed up to qa/revisions/<name>_<ts>_pre-regrade-<ch>.md at start.
- NO-NEW-FACTS guard: old/new chapter paragraphs are paired (difflib); a changed pair whose AFTER
  adds a concrete fact (Jev adds_fact >= 0.5) is rejected (old paragraph kept); 0.3-0.5 kept+FLAG;
  Jev unavailable -> UNCHECKED, current behaviour (paragraph kept as-is). --no-jev skips the guard.
- pairwise: per dimension Jev is asked choice {old,new,tie}; top p >= 0.8 decides for all 6 votes
  and the judge LLM pair call is skipped; otherwise the existing LLM call is used (fallback).
"""
import difflib, json, re, statistics, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA as QA_DIR, MS as MS_PATH, PANDOC, CHAPTERS  # noqa: E402
from backup import backup  # noqa: E402
from jev import decide  # noqa: E402

QA = QA_DIR
NUM = CHAPTERS

FACT_QUESTIONS = {
    "adds_fact": {"type": "noul",
                  "instructions": "Does AFTER state any concrete fact — number, date, amount, name, event — that BEFORE does not?",
                  "criteria": {"true": "AFTER contains at least one concrete fact absent from BEFORE.",
                               "false": "No new concrete facts in AFTER."}},
    "drops_fact": {"type": "noul",
                   "instructions": "Is any concrete fact in BEFORE (number, date, amount, name, event) missing from AFTER?",
                   "criteria": {"true": "At least one concrete fact is missing or altered.",
                                "false": "Every concrete fact survives unchanged."}},
}


def plain(s):
    """Strip Typst escapes/markup so Jev sees prose."""
    return re.sub(r"\s+", " ", s.replace("\\$", "$").replace("\\_", "_")).strip()


def fact_guard(old, new, use_jev=True):
    """NO-NEW-FACTS guard: pair old/new paragraphs (difflib) and ask Jev per changed pair.
    Returns (guarded_new_text, table_lines, flags). add >= 0.5 -> reject (keep old paragraph);
    0.3 <= add < 0.5 -> keep + FLAG; Jev down/off -> UNCHECKED, keep (current behaviour)."""
    po, pn = [p.strip() for p in old.split("\n\n") if p.strip()], [p.strip() for p in new.split("\n\n") if p.strip()]
    sm = difflib.SequenceMatcher(a=po, b=pn, autojunk=False)
    out, rows, flags = [], [], []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.extend(po[i1:i2])
            continue
        for k in range(max(i2 - i1, j2 - j1)):
            o = po[i1 + k] if i1 + k < i2 else None
            n = pn[j1 + k] if j1 + k < j2 else None
            if o is None or n is None:
                out.append(o if o is not None else n)
                continue
            add = drop = None
            if use_jev:
                a = decide({"before": plain(o), "after": plain(n)}, FACT_QUESTIONS, timeout=20)
                if a is not None:
                    add, drop = a["adds_fact"]["noul"], a["drops_fact"]["noul"]
            if add is None:
                verdict, keep = "UNCHECKED", n
            elif add >= 0.5:
                verdict, keep = "REJECT", o
            elif add >= 0.3:
                verdict, keep = "FLAG", n
            else:
                verdict, keep = "KEEP", n
            if verdict == "FLAG":
                flags.append(f"[{verdict}] {plain(n)[:120]}")
            rows.append((verdict, add, drop))
            out.append(keep)
    table = ["", "| Pair | Jev adds_fact | drops_fact | Verdict |", "|---|---|---|---|"]
    for i, (v, add, drop) in enumerate(rows, 1):
        table.append(f"| {i} | {'—' if add is None else f'{add:.2f}'} | {'—' if drop is None else f'{drop:.2f}'} | {v} |")
    for f in flags:
        table.append(f)
    return "\n\n".join(out), table, flags


def chapter_text(ms, n):
    from book_config import chapter_sources
    for name, title, src in chapter_sources(ms):
        if name == n:
            return title, prose(src)


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


def pair_prompt_dim(n, t, first, second, dim, first_is_old):
    return f"""You are a senior nonfiction editor. {BOOK}
Two versions of Chapter {n}, "{t}", follow: VERSION 1 and VERSION 2. {ANCHORS}
Which version is better on the dimension "{dim}"? Say "1", "2" or "tie". Judge quality, not length.
VERSION 1 is the {'OLD' if first_is_old else 'NEW'} text; VERSION 2 is the {'NEW' if first_is_old else 'OLD'} text.
Return JSON only: {{"{dim}": "1|2|tie"}}

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


def usage():
    print(__doc__)
    sys.exit(0)


def main():
    argv = sys.argv[1:]
    if "--help" in argv or "-h" in argv:
        usage()
    use_jev = "--no-jev" not in argv
    argv = [a for a in argv if a != "--no-jev"]
    if len(argv) != 2:
        usage()
    n, before = argv[0], Path(argv[1])
    from literary_panel import DIMS, JUDGES, PERSONAS, READER, BOOK, ANCHORS, call, judge_prompt, gi, gname, prose  # noqa: E402
    # backup before ANY manuscript write (none expected in this script, but guaranteed)
    bak = backup(MS_PATH, f"pre-regrade-{n}")
    print(f"backup: {bak}")
    new_ms, old_ms = MS_PATH.read_text(), before.read_text()
    t, new = chapter_text(new_ms, n)
    _, old = chapter_text(old_ms, n)
    if use_jev:
        new, guard_table, flags = fact_guard(old, new, use_jev=True)
        print("\n".join(guard_table))
        if flags:
            print(f"FLAGGED for founder review: {len(flags)} paragraph(s)")
    _, prev = chapter_text(new_ms, NUM[NUM.index(n) - 1])
    jobs = {("abs", j): (j, judge_prompt(n, t, new)) for j in JUDGES}
    # Jev pairwise pre-decision per dimension (plan point 5): p >= 0.8 decides and skips the LLM call
    jev_pair = {}
    if use_jev:
        for d in DIMS:
            a = decide({"before": plain(old)[:4000], "after": plain(new)[:4000]},
                       {f"pair": {"type": "choice", "instructions": f"Old vs new chapter text: which is better on the dimension '{d}'? "
                                                          "Judge quality, not length.",
                                  "criteria": {"old": "BEFORE is better on this dimension.",
                                               "new": "AFTER is better on this dimension.",
                                               "tie": "Both are equal on this dimension."}}}, timeout=20)
            if a is not None:
                c = a["pair"].get("choice")
                p = max((a["pair"].get("probabilities") or {"": 0}).values())
                if p >= 0.8:
                    jev_pair[d] = (c, p)
        if jev_pair:
            print("Jev-decided dimensions (LLM pair call skipped): "
                  + ", ".join(f"{d} -> {c} (p={p:.2f})" for d, (c, p) in jev_pair.items()))
    for j in JUDGES:
        for d in DIMS:
            if d not in jev_pair:
                jobs[("pair", j, "old-first", d)] = (j, pair_prompt_dim(n, t, old, new, d, True))
                jobs[("pair", j, "new-first", d)] = (j, pair_prompt_dim(n, t, new, old, d, False))
        jobs[("overall", j, "old-first")] = (j, pair_prompt(n, t, old, new))
        jobs[("overall", j, "new-first")] = (j, pair_prompt(n, t, new, old))
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
            if d in jev_pair:
                c = jev_pair[d][0]
                w[0 if c == "new" else (2 if c == "tie" else 1)] += 2
                continue
            for order in ("old-first", "new-first"):
                v = str((res[("pair", j, order, d)].get(d)) or "tie")
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
            r = res[("overall", j, order)]
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
    subprocess.run([str(PANDOC), "-f", "markdown-yaml_metadata_block", str(out), "-s", "--metadata",
                    f"title=Re-grade — Chapter {n}", "--embed-resources", "--css", str(QA / "report.css"), "-o", str(out.with_suffix(".html"))], check=False)
    print("\n".join(L))


if __name__ == "__main__":
    main()
