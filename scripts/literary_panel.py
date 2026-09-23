#!/usr/bin/env python3
"""Literary Quality Gate v2 (ADR 0044, rubric: data/intel/duane_book/qa/literary_rubric_v2.md).
Layer B  fact scan -> G1 candidates (two models, whole book; Claude verifies before relaying)
Layer C  3-family panel (Gemini 3.1 Pro/AGY, GLM 5.3 Flash, Muse Spark 1.3) -> 12 graded dimensions + G2, median grades
Layer E  simulated reader panel (3 personas, whole book) -> drop-off map
Writes qa/literary_runs/<ts>.json and qa/literary_assessment_v2.md. Read-only on the manuscript.
"""
import json, re, statistics, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from literary_metrics import MS, PARTS, prose  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
QA = REPO / "data/intel/duane_book/qa"
# Panel = 3 model families, all cost-effective (founder 2026-09-23). Sonnet/Opus 4.6 via AGY only for disputed grades.
JUDGES = ["agy:gemini-3.1-pro:low", "or:z-ai/glm-5.3-flash", "or:meta/muse-spark-1.3-contributor"]
FACT_CHECKERS = ["agy:gemini-3.1-pro:low", "or:deepseek/deepseek-v4.1-flash"]
READER = "agy:gemini-3.8-flash:low"
OR_PROVIDER = {"z-ai/glm-5.3-flash": "coreweave", "meta/muse-spark-1.3-contributor": "meta", "deepseek/deepseek-v4.1-flash": "coreweave"}
OR_KEY = next(l.split("=", 1)[1].strip().strip('"') for l in (Path(__file__).resolve().parent.parent / ".env").read_text().splitlines() if l.startswith("OPENROUTER_API_KEY="))
DIMS = ["Promise delivery", "Actionability", "Information value", "Originality", "Structure & arc", "Hook & ending",
        "Voice & prose", "Clarity & cohesion", "Pacing & density", "Stakes & momentum", "Human texture & example range", "Audience fit (55+)"]
SCALE = ["F", "D", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"]
BOOK = ("A first-person retirement memoir-guide by 'Duane', who retired at 59 in 2021 on $548,000 (no pension) and "
        "publishes his real balance monthly on YouTube. Audience: 55+ with $250K-$750K. Promise: 'you don't need a million "
        "dollars to retire' — real numbers, a boring repeatable method. 10 chapters in 3 parts.")
ANCHORS = ("Grade anchors: A = publishable at a top trade publisher as is; B = solid, needs an edit pass on this dimension; "
           "C = weaknesses a typical reader would notice; D/F = undermines the chapter. Use the full scale; do not inflate. "
           "Length-neutral: longer text is NOT better; judge quality per page, penalise padding.")


def call(spec, prompt, max_tokens=None):
    """spec = "agy:<model>:<effort>" (founder's paid AGY plan) or "or:<openrouter id>" (cost-effective models only)."""
    import subprocess, urllib.request
    backend, rest = spec.split(":", 1)
    budget = 24000
    for attempt in range(3):
        try:
            if backend == "agy":
                model, effort = rest.rsplit(":", 1)
                r = subprocess.run(["agy", "-p", prompt + "\n\nReturn ONLY the JSON object, no prose.", "--model", model,
                                    "--effort", effort, "--print-timeout", "0"], cwd="/tmp", stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True, timeout=900)
                txt = r.stdout
            else:
                # Provider pinned, never fallbacks (founder 2026-09-23: fallbacks break the cache and change the model host).
                body = json.dumps({"model": rest, "messages": [{"role": "user", "content": prompt + "\n\nReturn ONLY the JSON object."}],
                                   "max_tokens": budget, "reasoning": {"effort": "low"},
                                   "provider": {"order": [OR_PROVIDER[rest]], "allow_fallbacks": False},
                                   "usage": {"include": True}}).encode()
                req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body, headers={
                    "Authorization": f"Bearer {OR_KEY}", "Content-Type": "application/json",
                    "HTTP-Referer": "https://github.com/Hex-Tech-Lab/hex-expan-press", "X-Title": "ExpanPress Literary QA"})
                resp = json.load(urllib.request.urlopen(req, timeout=900))
                ch0 = resp["choices"][0]
                if ch0.get("finish_reason") == "length":
                    budget *= 2  # truncated JSON -> retry with a bigger budget instead of failing silently
                    raise ValueError(f"finish_reason=length at {budget // 2} tokens (provider {resp.get('provider')})")
                txt = ch0["message"].get("content") or ""
            return json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(5 * (attempt + 1))
    return {"_error": f"{spec}: {err}"}


def chapters():
    marks = [(m.start(), m.group(1), m.group(2)) for m in re.finditer(r'#chaphead\("Chapter (\w+)", "\d+", "([^"]+)"', MS)]
    return [(n, t, prose(MS[s:(marks[i + 1][0] if i + 1 < len(marks) else (MS.find('// BACK COVER') if '// BACK COVER' in MS else len(MS)))])) for i, (s, n, t) in enumerate(marks)]


def judge_prompt(n, title, text):
    dims = "\n".join(f"- {d}" for d in DIMS)
    return f"""You are one judge on a panel of senior nonfiction editors. {BOOK}
Grade Chapter {n}, "{title}", on each dimension with a letter grade ({' '.join(SCALE[::-1])}). {ANCHORS}
Dimensions (see definitions in parentheses):
{dims}
(Promise delivery = pays off the book's promise; Actionability = a 60-year-old can do something concrete after reading; Information value = specific, non-obvious, useful; Originality = what standard retirement books don't say; Structure & arc = hook→story→lesson→tool; Hook & ending = opening pull + landing; Voice & prose = distinct voice, clean sentences; Clarity & cohesion = easy to follow, transitions; Pacing & density = no drag, padding or repetition; Stakes & momentum = reader feels the risk, wants the next page; Human texture & example range = scenes, other voices, range of situations; Audience fit (55+) = reading level, jargon explained, respectful.)
Also judge gate G2 Credibility & compliance: PASS only if opinions are labelled, limits are stated where advice is given, external claims are sourced, and nothing reads as individual financial advice.
Every grade needs a verbatim quote (<= 20 words) from the chapter as evidence.
Return JSON only: {{"dims": {{"<dimension>": {{"grade": "B+", "quote": "...", "why": "<= 20 words"}}}}, "G2": {{"pass": true, "issues": ["..."]}}, "top_edits": ["<= 3 concrete edits, where and what"]}}

CHAPTER TEXT:
{text}"""


def fact_prompt(book):
    return f"""{BOOK}
Act as a fact-checker. Find every CONTRADICTION inside this manuscript: the same number, date, amount, age, rate or biographical fact stated differently in two places, or a statement contradicted by the book's own ledger/figures. Only real contradictions, not rounding (e.g. $548,000 vs 'a little over $500,000' is fine). Quote both places verbatim.
Return JSON only: {{"contradictions": [{{"fact": "...", "a": {{"chapter": "One", "quote": "..."}}, "b": {{"chapter": "Four", "quote": "..."}}, "severity": "high|medium|low"}}]}}

MANUSCRIPT (chapters separated by === Chapter N ===):
{book}"""


PERSONAS = {"pre-retiree": "a 58-year-old pre-retiree with $300,000 saved, anxious, reads carefully",
            "retiree": "a 66-year-old retired teacher with a pension and $450,000, skeptical of 'gurus'",
            "spouse": "the skeptical spouse of a 60-year-old who wants to retire early, reading to find holes"}


def reader_prompt(persona, book):
    return f"""You are {persona}. You are reading this book. {BOOK}
For EACH chapter report honestly as this reader: engagement 1-5; would you stop reading here (and at which sentence, verbatim <= 15 words); what felt repetitive; one thing you would actually do tomorrow (or 'nothing').
Then: would you recommend the book (yes/no + one sentence)?
Return JSON only: {{"chapters": {{"One": {{"engagement": 4, "stop_at": null, "repetitive": "...", "do_tomorrow": "..."}}}}, "recommend": {{"yes": true, "why": "..."}}}}

BOOK:
{book}"""


def to_html(md):
    """Every report also as HTML (founder preference)."""
    import subprocess
    subprocess.run([str(REPO / ".tools/pandoc/bin/pandoc"), "-f", "markdown-yaml_metadata_block", str(md), "-s", "--metadata", f"title={md.stem}",
                    "--embed-resources", "--css", str(QA / "report.css"), "-o", str(md.with_suffix(".html"))], check=False)


def gi(g):
    g = (g or "").strip().upper().replace("−", "-")
    return SCALE.index(g) if g in SCALE else None


def gname(i):
    return SCALE[max(0, min(len(SCALE) - 1, round(i)))]


def main():
    ch = chapters()
    book = "\n\n".join(f"=== Chapter {n}: {t} ===\n{x}" for n, t, x in ch)
    jobs = {("judge", n, j): (j, judge_prompt(n, t, x)) for n, t, x in ch for j in JUDGES}
    jobs.update({("facts", m): (m, fact_prompt(book)) for m in FACT_CHECKERS})
    jobs.update({("reader", p): (READER, reader_prompt(d, book)) for p, d in PERSONAS.items()})
    if "--from-run" in sys.argv:
        # rebuild the report from a saved run, optionally patched with re-run calls (no new model calls)
        src = json.loads(Path(sys.argv[sys.argv.index("--from-run") + 1]).read_text())
        res = {tuple(k.split("|")): v for k, v in src["raw"].items()}
        if "--patch" in sys.argv:
            for k, v in json.loads(Path(sys.argv[sys.argv.index("--patch") + 1]).read_text()).items():
                if "_error" not in v:
                    res[tuple(k.split("|"))] = v
    else:
        with ThreadPoolExecutor(4) as ex:
            futs = {k: ex.submit(call, m, pr) for k, (m, pr) in jobs.items()}
            res = {k: f.result() for k, f in futs.items()}
    run = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "judges": JUDGES,
           "raw": {"|".join(k): v for k, v in res.items()}}
    # ---- aggregate
    out, table, chap_overall, disagreements, g2 = [], {}, {}, [], {}
    for n, t, _ in ch:
        per = {}
        for d in DIMS:
            gs = [gi(((res[("judge", n, j)].get("dims") or {}).get(d) or {}).get("grade")) for j in JUDGES]
            gs = [g for g in gs if g is not None]
            per[d] = statistics.median(gs) if gs else None
            if gs and max(gs) - min(gs) > 3:
                disagreements.append(f"Ch {n} · {d}: {[gname(g) for g in gs]}")
        table[n] = per
        vals = [v for v in per.values() if v is not None]
        chap_overall[n] = statistics.median(vals) if vals else None
        passes = [(res[("judge", n, j)].get("G2") or {}).get("pass") for j in JUDGES]
        g2[n] = (sum(1 for p in passes if p) >= 2, [i for j in JUDGES for i in ((res[("judge", n, j)].get("G2") or {}).get("issues") or [])][:4])
    run.update({"table": {n: {d: (gname(v) if v is not None else None) for d, v in per.items()} for n, per in table.items()},
                "chapter_overall": {n: gname(v) for n, v in chap_overall.items() if v is not None}})
    (QA / "literary_runs").mkdir(exist_ok=True)
    (QA / "literary_runs" / f"{run['ts'].replace(':', '')}.json").write_text(json.dumps(run, indent=1, ensure_ascii=False))
    # ---- report
    names = [n for n, _, _ in ch]
    out += ["# Literary Quality Gate v2 — panel assessment", "",
            f"Run {run['ts']} · judges: {', '.join(JUDGES)} (median grade); facts: {', '.join(FACT_CHECKERS)}; readers: {READER} · rubric: `qa/literary_rubric_v2.md`", "",
            "## 1. Graded dimensions (panel median)", "", "| Dimension | " + " | ".join(f"Ch{i+1}" for i in range(len(names))) + " |",
            "|---|" + "---|" * len(names)]
    for d in DIMS:
        out.append(f"| {d} | " + " | ".join(gname(table[n][d]) if table[n][d] is not None else "—" for n in names) + " |")
    out.append("| **Chapter overall** | " + " | ".join(f"**{gname(chap_overall[n])}**" for n in names) + " |")
    out += ["", "## 2. Chapter verdicts (median ≥ B+, no dimension < B-, G2 pass)", ""]
    ch_pass = {}
    for n in names:
        mins = min(v for v in table[n].values() if v is not None)
        ok = chap_overall[n] >= gi("B+") and mins >= gi("B-") and g2[n][0]
        ch_pass[n] = ok
        low = [d for d, v in table[n].items() if v is not None and v < gi("B-")]
        out.append(f"- **Ch {n}: {'PASS' if ok else 'FAIL'}** — overall {gname(chap_overall[n])}; G2 {'pass' if g2[n][0] else 'FAIL'}"
                   + (f"; below B-: {', '.join(low)}" if low else "") + (f"; G2 issues: {'; '.join(g2[n][1][:2])}" if not g2[n][0] else ""))
    out += ["", "## 3. Part rollup (median ≥ A-, no chapter > 1 step below part median)", ""]
    for p, cs in PARTS.items():
        vals = [chap_overall[c] for c in cs if c in chap_overall]
        med = statistics.median(vals)
        dips = [c for c in cs if chap_overall[c] < med - 1]
        out.append(f"- **Part {p}: {'PASS' if med >= gi('A-') and not dips else 'FAIL'}** — median {gname(med)}" + (f"; dips: {', '.join(dips)}" if dips else ""))
    book_med = statistics.median(chap_overall.values())
    facts = [c for m in FACT_CHECKERS for c in (res[("facts", m)].get("contradictions") or [])]
    out += ["", "## 4. Book overall", "", f"**Overall: {gname(book_med)}** (median of chapter grades). Quality curve: "
            + " → ".join(f"{i+1}:{gname(chap_overall[n])}" for i, n in enumerate(names)), "",
            "## 5. Gate G1 — accuracy & consistency (candidates; Claude verifies each before it counts)", ""]
    for c in facts:
        try:
            out.append(f"- [{c.get('severity','?')}] {c.get('fact')}: Ch {c['a']['chapter']} “{c['a']['quote']}” vs Ch {c['b']['chapter']} “{c['b']['quote']}”")
        except Exception:  # noqa: BLE001
            pass
    out += ["", "## 6. Reader panel — drop-off map (engagement 1-5 per chapter)", "", "| Reader | " + " | ".join(f"Ch{i+1}" for i in range(len(names))) + " | Recommend |", "|---|" + "---|" * (len(names) + 1)]
    for p in PERSONAS:
        r = res[("reader", p)]
        chs = r.get("chapters") or {}
        out.append(f"| {p} | " + " | ".join(str((chs.get(n) or {}).get("engagement", "—")) for n in names) + f" | {'yes' if (r.get('recommend') or {}).get('yes') else 'no'} |")
    out += ["", "**Where readers would stop:**", ""]
    for p in PERSONAS:
        for n, v in ((res[("reader", p)].get("chapters") or {}).items()):
            if isinstance(v, dict) and v.get("stop_at"):
                out.append(f"- {p} · Ch {n}: “{v['stop_at']}”")
    out += ["", "## 7. Judge disagreements (> 1 grade step — human review)", ""] + [f"- {d}" for d in disagreements] + \
           ["", "## 8. Revision notes (per chapter, from the judges)", ""]
    for n in names:
        edits = [e for j in JUDGES for e in (res[("judge", n, j)].get("top_edits") or [])][:5]
        out.append(f"**Ch {n}**\n" + "\n".join(f"- {e}" for e in edits))
    errs = [v["_error"] for v in res.values() if isinstance(v, dict) and "_error" in v]
    if errs:
        out += ["", "## Errors", ""] + [f"- {e}" for e in errs]
    md = QA / "literary_assessment_v2.md"
    md.write_text("\n".join(out))
    to_html(md)
    print("\n".join(out[:40]))
    print(f"\nerrors: {len(errs)}")


if __name__ == "__main__":
    main()
