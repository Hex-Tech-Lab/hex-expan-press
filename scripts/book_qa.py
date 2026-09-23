#!/usr/bin/env python3
"""Book QA gate: checks the rule set (data/intel/duane_book/qa/design_rules.json) against the
manuscript source and the rendered PDF, chapter by chapter. Writes a Markdown checklist and
exits 2 if any blocker rule fails in the selected chapters.

Usage: book_qa.py --pdf proof.pdf --chapters One,Four [--out report.md]
"""
import argparse, json, re, sys
from collections import Counter, defaultdict
from pathlib import Path
import pdfplumber

REPO = Path(__file__).resolve().parent.parent
RULES = json.loads((REPO / "data/intel/duane_book/qa/design_rules.json").read_text())
R = {r["id"]: r for r in RULES["rules"]}
TOK = RULES["tokens"]


def _tok(expr):
    total = 0.0
    for part in expr.split("+"):
        g, k = part.strip().split(".")
        total += TOK[g][k]
    return round(total, 3)


# targets that are defined by tokens are derived, never duplicated (ADR 0043 single source)
for _r in R.values():
    if "token" in _r:
        _r["target"] = _tok(_r["token"])
R["BOX-PARA-GAP"]["target"] = {"lens": _tok("box.pitch+box.lens_extra"), "worksheet": _tok("box.pitch+box.worksheet_extra")}
MS = REPO / "manuscript/book/manuscript.md"
LEFT, INDENT = RULES["page"]["left_text_edge"], RULES["page"]["indent"]
CALLBG = (0.925, 0.894, 0.824)
NUMWORDS = "One Two Three Four Five Six Seven Eight Nine Ten".split()


def near(a, b, tol):
    return abs(a - b) <= tol


# ---------------------------------------------------------------- PDF model
class Line:
    def __init__(self, y, chars, box):
        self.y, self.chars, self.box = y, chars, box
        fonts = Counter()
        for c in chars:
            if c["text"].strip():
                fonts[(c["fontname"].split("+")[-1], round(c["size"], 2))] += 1
        (self.font, self.size), _ = fonts.most_common(1)[0] if fonts else (("", 0), 0)
        self.fam = re.sub(r"-.*", "", self.font)
        self.x = min(c["x0"] for c in chars if c["text"].strip()) if any(c["text"].strip() for c in chars) else chars[0]["x0"]
        self.text = "".join(c["text"] for c in sorted(chars, key=lambda c: c["x0"]))
        self.kind = "?"


def page_model(p):
    boxes = [r for r in p.rects + p.curves if r.get("fill") and r.get("non_stroking_color") and len(r["non_stroking_color"]) == 3
             and all(near(a, b, 0.01) for a, b in zip(r["non_stroking_color"], CALLBG)) and r["height"] > 30]
    rows = defaultdict(list)
    for c in p.chars:
        y = round(p.height - c["matrix"][5], 2)
        bi = next((i for i, b in enumerate(boxes) if b["x0"] - 1 <= c["x0"] <= b["x1"] + 1 and b["top"] - 1 <= c["top"] <= b["bottom"] + 1), None)
        rows[(bi, y)].append(c)
    lines = [Line(y, cs, bi) for (bi, y), cs in rows.items() if any(c["text"].strip() for c in cs)]
    lines.sort(key=lambda l: l.y)
    has_table = any(l.fam == "Inter" and near(l.size, 7.2, 0.05) for l in lines)
    tb = [l.y for l in lines if l.fam == "Inter" and near(l.size, 7.2, 0.05)]
    for l in lines:
        t = l.text.replace(" ", "").upper()
        if l.y < 45 and l.fam == "Inter":
            l.kind = "runhead"
        elif l.y > 590 and l.fam == "LibreCaslonText" and near(l.size, 9.0, 0.05):
            l.kind = "folio"
        elif l.box is not None:
            l.kind = {7.8: "boxhead", 9.5: "boxbody", 8.6: "boxnote"}.get(round(l.size, 1), "boxother")
        elif has_table and tb and tb[0] - 30 <= l.y <= tb[-1] + 25 and not (l.fam == "LibreCaslonText" and near(l.size, 11.5, 0.05)):
            l.kind = "table"
        elif t.startswith("CHAPTER") and l.fam == "Inter":
            l.kind = "kicker"
        elif l.fam == "FrauncesDisplay" and l.size >= 20 and l.size < 30:
            l.kind = "title"
        elif l.fam == "FrauncesDisplay" and l.size >= 30:
            l.kind = "dropcap"
        elif l.fam == "FrauncesDisplay" and "Italic" in l.font:
            l.kind = "takeaway"
        elif l.fam == "FrauncesDisplay":
            l.kind = "heading"
        elif l.fam == "Inter":
            l.kind = "caps"
        elif l.fam == "LibreCaslonText":
            l.kind = "body"
        else:
            l.kind = "other"
    return lines, boxes


# ---------------------------------------------------------------- results
class Results:
    def __init__(self):
        self.fail = defaultdict(list)
        self.checked = Counter()

    def check(self, rid, ok, where=""):
        self.checked[rid] += 1
        if not ok:
            self.fail[rid].append(where)


def snip(l):
    return l.text.strip()[:48]


def check_pdf(pdf, first, last, res, is_opener_page):
    boxes_in_chapter = []
    for pno in range(first, last + 1):
        p = pdf.pages[pno - 1]
        lines, boxes = page_model(p)
        text = "".join(l.text for l in lines)
        content = [l for l in lines if l.kind not in ("runhead", "folio")]
        opener = pno == first
        # NO-LEAK
        leak = re.search(r"```|\{=typst\}|#(callout|worksheet|set|show|block|grid|h\(|enum|stack|place)", text)
        res.check("NO-LEAK", not leak, f"p{pno}: …{leak.group(0) if leak else ''}")
        # FURNITURE
        has_rh = any(l.kind == "runhead" for l in lines)
        has_fo = any(l.kind == "folio" for l in lines)
        text_page = any(l.kind in ("body", "heading", "boxbody", "boxhead", "takeaway", "table", "caps") for l in content)
        if opener:
            res.check("FURNITURE", not has_rh and not has_fo, f"p{pno}: opener page has header/folio")
        elif text_page:
            res.check("FURNITURE", has_rh and has_fo, f"p{pno}: text page missing header or folio")
        else:
            res.check("FURNITURE", not has_rh and not has_fo, f"p{pno}: blank/photo page has header/folio")
        # BOX-ONE-PER-PAGE
        res.check("BOX-ONE-PER-PAGE", len(boxes) <= 1, f"p{pno}: {len(boxes)} boxes")
        for bi, b in enumerate(boxes):
            head = [l for l in lines if l.box == bi and l.kind == "boxhead"]
            boxes_in_chapter.append((pno, "".join(l.text for l in head).replace(" ", "").upper()))
        # per-line rules
        for i, l in enumerate(content):
            prev = content[i - 1] if i else None
            d = round(l.y - prev.y, 3) if prev else None
            if l.kind == "body":
                res.check("BODY-FONT", near(l.size, 11.5, 0.05), f"p{pno}: {l.size}pt '{snip(l)}'")
            if l.kind == "heading":
                res.check("HEAD-STYLE", near(l.size, 13.5, 0.05), f"p{pno}: {l.size}pt '{snip(l)}'")
                nxt = content[i + 1] if i + 1 < len(content) else None
                res.check("HEAD-ORPHAN", nxt is not None, f"p{pno}: '{snip(l)}' is last on page")
                if prev is not None and prev.kind == "body":
                    res.check("HEAD-BEFORE", near(d, R["HEAD-BEFORE"]["target"], R["HEAD-BEFORE"]["tol"]), f"p{pno}: {d} before '{snip(l)}'")
            if l.kind == "boxhead":
                res.check("BOX-HEAD-FONT", l.fam == "Inter" and near(l.size, 7.8, 0.05), f"p{pno}: {l.font} {l.size}")
                if prev is not None and prev.kind == "boxhead" and prev.box == l.box:
                    res.check("BOX-HEAD-PITCH", near(d, R["BOX-HEAD-PITCH"]["target"], R["BOX-HEAD-PITCH"]["tol"]), f"p{pno}: {d} '{snip(l)}'")
            if l.kind == "boxbody":
                res.check("BOX-BODY-FONT", l.fam == "LibreCaslonText" and near(l.size, 9.5, 0.05), f"p{pno}: {l.font} {l.size}")
                if prev is not None and prev.box == l.box:
                    if prev.kind == "boxhead":
                        res.check("BOX-HEAD-TO-BODY", near(d, R["BOX-HEAD-TO-BODY"]["target"], R["BOX-HEAD-TO-BODY"]["tol"]), f"p{pno}: {d} '{snip(l)}'")
                    elif prev.kind == "boxbody":
                        ws = any(x.box == l.box and x.kind == "boxhead" and x.text.replace(" ", "").upper().startswith("YOURWORKSHEET") for x in content)
                        gap = R["BOX-PARA-GAP"]["target"]["worksheet" if ws else "lens"]
                        ok = near(d, R["BOX-BODY-PITCH"]["target"], R["BOX-BODY-PITCH"]["tol"]) or near(d, gap, R["BOX-PARA-GAP"]["tol"])
                        res.check("BOX-BODY-PITCH" if d < gap - 2 else "BOX-PARA-GAP", ok, f"p{pno}: {d} '{snip(l)}'")
            if l.kind == "body" and prev is not None:
                if prev.kind == "body":
                    pitch_ok = near(d, R["BODY-PITCH"]["target"], R["BODY-PITCH"]["tol"])
                    gap_ok = near(d, R["BODY-PARA-GAP"]["target"], R["BODY-PARA-GAP"]["tol"])
                    res.check("BODY-PITCH" if d < 23 else "BODY-PARA-GAP", pitch_ok or gap_ok, f"p{pno}: {d} '{snip(l)}'")
                    in_dropcap = opener and any(x.kind == "dropcap" for x in content) and l.x > LEFT + 2 and i < 8
                    if gap_ok:
                        res.check("BODY-INDENT", near(l.x, LEFT + INDENT, 0.5), f"p{pno}: new paragraph at x={l.x:.1f} (want {LEFT+INDENT}) '{snip(l)}'")
                    elif pitch_ok and not in_dropcap:
                        res.check("BODY-INDENT", near(l.x, LEFT, 0.5) or near(l.x, LEFT + INDENT, 0.5), f"p{pno}: x={l.x:.1f} '{snip(l)}'")
                elif prev.kind == "heading":
                    res.check("HEAD-AFTER", near(d, R["HEAD-AFTER"]["target"], R["HEAD-AFTER"]["tol"]), f"p{pno}: {d} after '{snip(prev)}'")
                    res.check("BODY-INDENT", near(l.x, LEFT, 0.5), f"p{pno}: first line after heading indented '{snip(l)}'")
                elif prev.kind in ("boxbody", "boxnote", "boxhead", "table", "dropcap"):
                    res.check("BODY-INDENT", near(l.x, LEFT + INDENT, 0.5), f"p{pno}: paragraph after {prev.kind} not indented '{snip(l)}'")
        # TABLE-ONE-PAGE
        if any(l.kind == "table" and l.text.replace(" ", "").upper() == "DATE" or l.text.replace(" ", "").upper().startswith("DATETOTAL") for l in lines):
            rows = [l for l in lines if l.kind == "table" and l.fam == "Inter" and re.match(r"(AUG|EOY|FEB|JAN|JUL|JUN|MAR|APR|MAY|SEP|OCT|NOV|DEC)\d{4}", l.text.replace(" ", "").upper())]
            res.check("TABLE-ONE-PAGE", len(rows) >= 9, f"p{pno}: only {len(rows)} table rows on the table's first page")
    if boxes_in_chapter:
        ws = [i for i, (_, h) in enumerate(boxes_in_chapter) if h.startswith("YOURWORKSHEET")]
        res.check("BOX-WORKSHEET-LAST", bool(ws) and ws[-1] == len(boxes_in_chapter) - 1,
                  f"box order: {[h[:14] for _, h in boxes_in_chapter]}")


# ---------------------------------------------------------------- source lint
def chapter_src_ranges(lines):
    starts = {}
    for i, l in enumerate(lines):
        m = re.search(r'#chaphead\("Chapter (\w+)"', l)
        if m:
            starts[m.group(1)] = i
    order = sorted(starts.items(), key=lambda kv: kv[1])
    return {n: (s, order[k + 1][1] if k + 1 < len(order) else len(lines)) for k, (n, s) in enumerate(order)}


def check_src(lines, a, b, res):
    fence = sum(1 for l in lines[:a] if l.startswith("```")) % 2 == 1
    depth = 0
    ws_depth = None
    for i in range(a, b):
        l, n = lines[i], i + 1
        if re.match(r"^\s+```", l):
            res.check("SRC-FENCE", False, f"line {n}: indented fence")
            continue
        if l.startswith("```"):
            fence, depth = (not fence), 0
            res.check("SRC-FENCE", True)
            continue
        if fence:
            code = re.sub(r'"[^"]*"', "", l)
            stripped = code.strip()
            if re.match(r"#(set|show)\b", stripped):
                res.check("SRC-TOPLEVEL-SET", depth > 0, f"line {n}: {stripped[:50]}")
            if re.match(r"#v\(", stripped) and depth == 0:
                res.check("SRC-MANUAL-SPACE", False, f"line {n}: {stripped[:40]}")
            if "#block(above: 0pt" in code:
                res.check("SRC-ABOVE0", False, f"line {n}")
            if "#worksheet(" in code:
                ws_depth = depth
            if ws_depth is not None and re.search(r"#stack\(|#grid\(|^\s*\d+\.\s", code):
                res.check("SRC-HANDBUILT-LIST", False, f"line {n}: {stripped[:50]}")
            depth += code.count("[") - code.count("]")
            if ws_depth is not None and depth <= ws_depth:
                ws_depth = None
        else:
            body = l.strip()
            if re.search(r"\S {2,}\S", body):
                res.check("SRC-DOUBLE-SPACE", False, f"line {n}: '{body[:60]}'")
            prev = lines[i - 1] if i else ""
            if re.match(r"^\s{2,}[A-Z]", l) and prev.strip() and not prev.startswith("#") and re.search(r"[.?!”\"}]$", prev.rstrip()):
                res.check("SRC-MERGED-PARA", False, f"line {n}: '{body[:50]}'")
    for rid in ("SRC-MANUAL-SPACE", "SRC-TOPLEVEL-SET", "SRC-ABOVE0", "SRC-HANDBUILT-LIST", "SRC-DOUBLE-SPACE", "SRC-MERGED-PARA", "SRC-FENCE"):
        res.check(rid, True)


# ---------------------------------------------------------------- main
def pdf_chapter_ranges(pdf):
    openers = {}
    for i, p in enumerate(pdf.pages):
        t = "".join(c["text"] for c in p.chars).replace(" ", "").upper()
        for w in NUMWORDS:
            if f"CHAPTER{w.upper()}" in t and w not in openers:
                openers[w] = i + 1
    order = sorted(openers.items(), key=lambda kv: kv[1])
    out = {}
    for k, (w, s) in enumerate(order):
        e = order[k + 1][1] - 1 if k + 1 < len(order) else len(pdf.pages)
        out[w] = (s, e)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--chapters", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    pdf = pdfplumber.open(a.pdf)
    src = MS.read_text().split("\n")
    pr, sr = pdf_chapter_ranges(pdf), chapter_src_ranges(src)
    out = [f"# Book QA report — `{Path(a.pdf).name}`", "", f"Rule set: `{RULES['adr']}` v{RULES['version']}", ""]
    blockers = 0
    for ch in a.chapters.split(","):
        res = Results()
        if ch in pr:
            s, e = pr[ch]
            # stop at the chapter's last page before any photo/part page: last page with body text is fine either way
            check_pdf(pdf, s, e, res, None)
        if ch in sr:
            check_src(src, *sr[ch], res)
        out += [f"## Chapter {ch}" + (f" (pp. {pr[ch][0]}–{pr[ch][1]})" if ch in pr else ""), "",
                "| Rule | Object / relationship | Target | Checks | Result |", "|---|---|---|---|---|"]
        for r in RULES["rules"]:
            rid, n, f = r["id"], res.checked[r["id"]], len(res.fail[r["id"]])
            status = "—" if n == 0 else ("PASS" if f == 0 else ("FAIL" if r["severity"] == "blocker" else "WARN"))
            if status == "FAIL":
                blockers += 1
            tgt = r["target"] if not isinstance(r["target"], dict) else ", ".join(f"{k} {v}" for k, v in r["target"].items())
            out.append(f"| {rid} | {r['object']} | {tgt}{' ±'+str(r['tol']) if 'tol' in r else ''} | {n} | {status}{f' ({f})' if f else ''} |")
        fails = [(rid, w) for rid in R for w in res.fail[rid]]
        if fails:
            out += ["", "**Failures:**", ""] + [f"- `{rid}` {w}" for rid, w in fails[:60]]
            if len(fails) > 60:
                out.append(f"- … {len(fails) - 60} more")
        out.append("")
    report = "\n".join(out)
    if a.out:
        Path(a.out).write_text(report)
    print(report)
    print(f"\nQA: {'FAIL' if blockers else 'PASS'} ({blockers} blocker rule(s) failing)")
    sys.exit(2 if blockers else 0)


if __name__ == "__main__":
    main()
