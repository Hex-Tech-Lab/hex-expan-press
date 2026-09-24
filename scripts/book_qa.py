#!/usr/bin/env python3
"""Book QA gate: checks the rule set (design_rules.json under the book's QA dir) against the
manuscript source and the rendered PDF, chapter by chapter. Writes a Markdown checklist and
exits 2 if any blocker rule fails in the selected chapters.

Usage: book_qa.py --pdf proof.pdf --chapters One,Four [--out report.md]
"""
import sys
import argparse, json, re, sys
from collections import Counter, defaultdict
from pathlib import Path
import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import MS, QA, CHAPTERS

RULES = json.loads((QA / "design_rules.json").read_text())
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
# T27 rules: design_rules.json is frozen for this task, so the two new rules are
# defined here (same schema) and appended to the report rule list in code.
EXTRA_RULES = [
    {"id": "TAKEAWAY-ORPHAN", "object": "rendered PDF", "kind": "pdf",
     "target": {"top_frac": 0.30, "empty_frac": 0.12}, "severity": "major",
     "source": "T27 2026-09-24: takeaway block stranded at top of a page while the previous page ends high"},
    {"id": "IMG-UNIQUE", "object": "manuscript source", "kind": "source",
     "target": "each img/#image path used at most once across the whole book", "severity": "blocker",
     "source": "T27 2026-09-24: duplicate cover/opener/back-cover image paths"},
    {"id": "BODY-MERGED", "object": "rendered PDF", "kind": "pdf",
     "target": "each source paragraph's first 6 words begin a PDF line at left margin ±1pt or left margin+indent ±1pt",
     "severity": "blocker",
     "source": "T33-J3 2026-09-24: raw typst fence swallowing the next paragraph (merged-paragraph bug)"},
]
for _r in EXTRA_RULES:
    R[_r["id"]] = _r
    RULES["rules"].append(_r)
LEFT, INDENT = RULES["page"]["left_text_edge"], RULES["page"]["indent"]
CALLBG = (0.925, 0.894, 0.824)
NUMWORDS = list(CHAPTERS)


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


PART_RE = re.compile(r"PART[IVXLCDM]+$")


def is_part_page(lines):
    """A part page begins with 'PART' + roman numeral (may be letter-spaced)."""
    content = [l for l in lines if l.kind not in ("runhead", "folio")]
    return any(PART_RE.fullmatch(re.sub(r"\s+", "", l.text).upper()) for l in content[:3])


def last_content_page(pdf, first, last):
    """Trim trailing pages (part pages / furniture remnants / blanks) left by a proof build."""
    while last > first:
        lines, _ = page_model(pdf.pages[last - 1])
        content = [l for l in lines if l.kind not in ("runhead", "folio")]
        if content and not is_part_page(lines):
            break
        last -= 1
    return last


def dropcap_gap_check(p, res, pno):
    """DROPCAP-GAP: first body-text char x0 on the drop-cap rows minus the right
    ink edge of the drop-cap glyph (wine ink found at 600 dpi render)."""
    dc = [c for c in p.chars if c["fontname"].split("+")[-1].startswith("FrauncesDisplay") and c["size"] >= 30]
    if not dc:
        return
    bx0 = min(c["x0"] for c in dc)
    bx1 = max(c["x1"] for c in dc)
    btop = min(c["top"] for c in dc)
    bbot = max(c["bottom"] for c in dc)
    body = [c for c in p.chars if c["fontname"].split("+")[-1].startswith("LibreCaslonText")
            and near(c["size"], 11.5, 0.05) and c["bottom"] > btop and c["top"] < bbot and c["x0"] > bx0]
    if not body:
        return
    body_x0 = min(c["x0"] for c in body)
    pad = 2
    crop = (max(0, bx0 - pad), max(0, btop - pad), min(p.width, bx1 + pad), min(p.height, bbot + pad))
    pil = p.crop(crop).to_image(resolution=600).original.convert("RGB")
    W, H = pil.size
    px = pil.load()
    right_px = None
    for x in range(W - 1, -1, -1):
        for y in range(H):
            r, g, b = px[x, y]
            if r < 200 and (r - b) > 30:
                right_px = x
                break
        if right_px is not None:
            break
    if right_px is None:
        res.check("DROPCAP-GAP", False, f"p{pno}: drop-cap ink not found in glyph bbox")
        return
    ink_right = crop[0] + right_px * 72.0 / 600
    gap_mm = (body_x0 - ink_right) * 25.4 / 72
    r_ = R["DROPCAP-GAP"]
    res.check("DROPCAP-GAP", near(gap_mm, r_["target_mm"], r_["tol"]),
              f"p{pno}: visible gap {gap_mm:.2f}mm (want {r_['target_mm']}±{r_['tol']}mm)")


def opener_img_check(p, res, pno):
    """OPENER-IMG-SIZE: every opener photo placed at width 432pt x opener.image_h,
    top-left at the page's top-left bleed. pdfplumber reports the unclipped image
    object for fit:'cover' placements; the visible box is the intersection with the
    432 x img_h clip box at the top-left corner."""
    tok_h = TOK["opener"]["image_h"]
    imgs = [im for im in p.images if (im["x1"] - im["x0"]) >= 0.8 * p.width and im["top"] <= 0.3 * p.height]
    for im in imgs:
        px0, px1 = max(im["x0"], 0.0), min(im["x1"], p.width)
        ptop, pbot = max(im["top"], 0.0), min(im["bottom"], float(tok_h))
        w, h = px1 - px0, pbot - ptop
        ok = near(w, p.width, 0.5) and near(h, tok_h, 0.5) and near(px0, 0.0, 0.5) and near(ptop, 0.0, 0.5)
        res.check("OPENER-IMG-SIZE", ok,
                  f"p{pno}: placed {w:.2f}x{h:.2f}pt at ({px0:.2f},{ptop:.2f}) "
                  f"(want {p.width:.0f}x{tok_h} at (0,0))")


def page_gap_check(page_info, page_body_pos, boxes_in_chapter, first, last, res):
    """PAGE-GAP: a text page that ends with a large empty area before a breakout
    box on the next page; or a box followed by < 3 body lines and a >= 30% empty
    bottom before the next box on the following page (the Ch3 pattern)."""
    tgt = R["PAGE-GAP"]["target"]
    for pno in range(first, last + 1):
        info = page_info[pno]
        if info is None:
            continue
        content, boxes, opener, part, ph = info
        if not content:
            continue
        res.check("PAGE-GAP", True)
        tb_bot = ph - tgt["bottom_margin"]
        tbh = tb_bot - tgt["top_margin"]
        lowest = max(l.y for l in content)
        empty_frac = (tb_bot - lowest) / tbh
        next_boxes = [(ppb_top) for (pn, ppb_top, _, _) in boxes_in_chapter if pn == pno + 1]
        next_box_top = min(next_boxes) if next_boxes else None
        text_page = any(l.kind in ("body", "heading", "boxbody", "boxhead", "takeaway", "table", "caps") for l in content)
        # pattern A: mostly-empty text page, no box on it, box on the next page
        if (not opener and not part and text_page and not boxes and pno < last
                and empty_frac > tgt["empty_frac"] and next_box_top is not None
                and next_box_top < 0.5 * ph):
            res.check("PAGE-GAP", False, f"p{pno}: {empty_frac*100:.0f}% empty before box on p{pno+1}: move the box up / reflow")
        # pattern B: box, < 3 body lines, >= 30% empty bottom, next box on the following page
        for i, (pa, ba, bbot, ha) in enumerate(boxes_in_chapter):
            if pa != pno or opener or part:
                continue
            after = [y for y in page_body_pos.get(pno, []) if y > bbot]
            nxt = boxes_in_chapter[i + 1] if i + 1 < len(boxes_in_chapter) else None
            if (len(after) < tgt["min_body_after_box"] and empty_frac >= tgt["gap_frac"]
                    and nxt and nxt[0] == pno + 1 and nxt[1] < 0.5 * ph):
                res.check("PAGE-GAP", False, f"p{pno}: box ends y={bbot:.0f}, {len(after)} body lines, {empty_frac*100:.0f}% empty before box on p{pno+1}: move the box up / reflow")


def takeaway_orphan_check(page_info, first, last, res):
    """TAKEAWAY-ORPHAN: a chapter's THE TAKEAWAY block starting in the top 30% of
    a page's text area while the previous page's last body/box content leaves
    >= 12% of the text area empty below it (the block was pushed over)."""
    tgt = R["TAKEAWAY-ORPHAN"]["target"]
    pg = R["PAGE-GAP"]["target"]
    for pno in range(first, last + 1):
        info = page_info.get(pno)
        if info is None:
            continue
        content, boxes, opener, part, ph = info
        if not content:
            continue
        res.check("TAKEAWAY-ORPHAN", True)
        tk = [l for l in content if l.kind == "takeaway"]
        if not tk or pno == first:
            continue
        tb_bot = ph - pg["bottom_margin"]
        tbh = tb_bot - pg["top_margin"]
        if not (tk[0].y <= pg["top_margin"] + tgt["top_frac"] * tbh):
            continue
        prev = page_info.get(pno - 1)
        if prev is None:
            continue
        pcontent, _, popener, ppart, _ = prev
        if popener or ppart or not pcontent:
            continue
        lowest = max(l.y for l in pcontent)
        empty_frac = (tb_bot - lowest) / tbh
        if empty_frac >= tgt["empty_frac"]:
            res.check("TAKEAWAY-ORPHAN", False,
                      f"p{pno}: takeaway pushed to p{pno} with {empty_frac*100:.0f}% empty on p{pno-1}")


IMG_RE = re.compile(r'#chaphead\([^)]*?img:\s*"([^"]+)"')
IMAGE_RE = re.compile(r'#image\("([^"]+)"\)')


# ---------------------------------------------------------------- BODY-MERGED (T33-J3)
MARKUP_SPAN = re.compile(r"`[^`]*`\{=typst\}")
TYPS_CALL = re.compile(r"#\w+(?:\((?:[^()]|\([^()]*\))*\))?")
NOT_PARA = re.compile(r"^(#{1,6} |#|[-*] |\d+\. |\||!|>)")


def _norm_prose(s):
    """Lowercase alnum+space view of text: markup, typst calls, punctuation gone."""
    s = MARKUP_SPAN.sub("", s)
    s = TYPS_CALL.sub(" ", s)
    s = s.replace("\\_", "_").replace("\\$", "$").replace("\\[", "[").replace("\\]", "]").replace("\\", "")
    s = re.sub(r"[^A-Za-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def prose_paragraphs(src, a, b):
    """[(first_line_no, first_words_raw, match_seq)] for markdown prose paragraphs in
    src[a:b]: blank-line-separated blocks outside fences, not heading/list/markup;
    the first prose block after every fence close is also a paragraph."""
    fence = sum(1 for l in src[:a] if l.startswith("```")) % 2 == 1
    paras, block = [], {"lines": [], "start": None}

    def flush():
        if block["lines"]:
            t = _norm_prose(" ".join(block["lines"]))
            w = t.split()
            if len(w) >= 4:
                paras.append((block["start"], " ".join(w[:6]), " ".join(w[:6])))
        block["lines"], block["start"] = [], None

    for i in range(a, b):
        l = src[i]
        s = l.strip()
        if l.startswith("```"):
            fence = not fence
            flush()
            continue
        if fence:
            continue
        if not s:
            flush()
            continue
        if block["start"] is None:
            if NOT_PARA.match(s):
                continue
            block["start"] = i + 1
        block["lines"].append(s)
    flush()
    return paras


def body_merged_check(pdf, first, last, src, a, b, res):
    """BODY-MERGED: a source paragraph's first 6 words must begin a PDF line whose
    x0 is at the left margin or left margin + indent (±1pt). If they appear only
    mid-line — wholly inside one line, or split so the first k words end the
    previous line — the paragraph was merged into the previous one (raw typst
    fence with no parbreak). Unfindable sequences (hyphenation) pass."""
    paras = prose_paragraphs(src, a, b)
    res.check("BODY-MERGED", True)
    if not paras:
        return
    models, flat, opener_dc = {}, [], False
    for pno in range(first, last + 1):
        lines, _ = page_model(pdf.pages[pno - 1])
        lines = [l for l in lines if l.kind not in ("runhead", "folio")]
        models[pno] = lines
        flat += [(pno, l, _norm_prose(l.text)) for l in lines]
    opener_dc = any(l.kind == "dropcap" for l in models.get(first, []))
    for _, raw, seq in paras:
        words = seq.split()
        ok = fail = None
        only_dropcap = False
        for j, (pno, l, t) in enumerate(flat):
            if not t:
                continue
            idx = t.find(seq)
            if idx == 0 and (near(l.x, LEFT, 1.0) or near(l.x, LEFT + INDENT, 1.0)):
                ok = pno
                break
            if idx >= 0:
                if opener_dc and pno == first and l.x > LEFT + 2:
                    only_dropcap = True  # drop-cap opener paragraph: x0 beside the glyph, unjudgeable
                elif fail is None:
                    fail = (pno, raw)
                continue
            # split across a line boundary: first k words end line j mid-line, rest begin line j+1
            for k in range(1, len(words)):
                pre, suf = " ".join(words[:k]), " ".join(words[k:])
                pidx = t.find(pre)
                if pidx <= 0:
                    continue
                if j + 1 >= len(flat) or not flat[j + 1][2].startswith(suf):
                    continue
                npno, nl, _ = flat[j + 1]
                if opener_dc and pno == first and l.x > LEFT + 2:
                    only_dropcap = True
                    break
                if fail is None:
                    fail = (pno, raw)
                break
        if ok or (only_dropcap and fail is None):
            continue
        if fail:
            res.check("BODY-MERGED", False, f"p{fail[0]}: paragraph merged into previous: '{fail[1]}'")



def img_unique_uses(src):
    """All cover/opener/back-cover image paths in manuscript order (1-based lines)."""
    uses = []
    for i, l in enumerate(src):
        for m in (*IMG_RE.findall(l), *IMAGE_RE.findall(l)):
            uses.append((m, i + 1))
    return uses


def check_pdf(pdf, first, last, res, is_opener_page):
    boxes_in_chapter = []
    body_pos = {}
    page_info = {}
    for pno in range(first, last + 1):
        p = pdf.pages[pno - 1]
        lines, boxes = page_model(p)
        text = "".join(l.text for l in lines)
        content = [l for l in lines if l.kind not in ("runhead", "folio")]
        opener = pno == first
        page_info[pno] = (content, boxes, opener, is_part_page(lines), p.height)
        if opener:
            missing = []
            imgs = [im for im in p.images if (im["x1"] - im["x0"]) >= 0.8 * p.width and im["top"] <= 0.3 * p.height]
            if not imgs:
                missing.append("full-width image in top 30%")
            if not any(l.kind == "kicker" for l in lines):
                missing.append("CHAPTER <N>")
            if not any(l.kind == "title" for l in lines):
                missing.append("chapter title")
            if not any(c["fontname"].split("+")[-1].startswith("FrauncesDisplay") and c["size"] >= 30 for c in p.chars):
                missing.append("drop-cap glyph")
            if not any(l.kind == "body" for l in content):
                missing.append("first body text")
            res.check("OPENER-MODEL", not missing, f"p{pno}: missing {', '.join(missing)}")
            opener_img_check(p, res, pno)
            dropcap_gap_check(p, res, pno)
        # NO-LEAK
        leak = re.search(r"```|\{=typst\}|#(callout|worksheet|set|show|block|grid|h\(|enum|stack|place)", text)
        res.check("NO-LEAK", not leak, f"p{pno}: …{leak.group(0) if leak else ''}")
        # FURNITURE
        has_rh = any(l.kind == "runhead" for l in lines)
        has_fo = any(l.kind == "folio" for l in lines)
        text_page = any(l.kind in ("body", "heading", "boxbody", "boxhead", "takeaway", "table", "caps") for l in content)
        if opener:
            res.check("FURNITURE", not has_rh and not has_fo, f"p{pno}: opener page has header/folio")
        elif is_part_page(lines):
            res.check("FURNITURE", not has_rh and not has_fo, f"p{pno}: part page has header/folio")
        elif text_page:
            res.check("FURNITURE", has_rh and has_fo, f"p{pno}: text page missing header or folio")
        else:
            res.check("FURNITURE", not has_rh and not has_fo, f"p{pno}: blank/photo page has header/folio")
        # BOX-ONE-PER-PAGE
        res.check("BOX-ONE-PER-PAGE", len(boxes) <= 1, f"p{pno}: {len(boxes)} boxes")
        # BOX-SEPARATION inputs
        body_pos[pno] = [l.y for l in content if l.kind == "body" and l.box is None]
        for bi, b in enumerate(boxes):
            head = [l for l in lines if l.box == bi and l.kind == "boxhead"]
            boxes_in_chapter.append((pno, b["top"], b["bottom"], "".join(l.text for l in head).replace(" ", "").upper()))
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
            # List items (bullet/number marker) and their hanging continuation lines are not body
            # paragraphs: skip the indent checks for them (they keep the pitch checks).
            lst = l.kind == "body" and (l.text.lstrip()[:1] in "•–" or re.match(r"^\d+\.", l.text.strip()) is not None)
            lst_cont = (l.kind == "body" and prev is not None and getattr(prev, "_list", False)
                        and not near(l.x, LEFT, 0.5) and not near(l.x, LEFT + INDENT, 0.5))
            l._list = lst or lst_cont
            if l.kind == "body" and prev is not None and l._list:
                if prev.kind == "body":
                    res.check("BODY-PITCH" if d < 23 else "BODY-PARA-GAP", near(d, R["BODY-PITCH"]["target"], R["BODY-PITCH"]["tol"]) or near(d, R["BODY-PARA-GAP"]["target"], R["BODY-PARA-GAP"]["tol"]) or d < 18, f"p{pno}: {d} '{snip(l)}'")
            elif l.kind == "body" and prev is not None:
                if prev.kind == "body":
                    pitch_ok = near(d, R["BODY-PITCH"]["target"], R["BODY-PITCH"]["tol"])
                    gap_ok = near(d, R["BODY-PARA-GAP"]["target"], R["BODY-PARA-GAP"]["tol"])
                    # A section ornament (three small dots) between the two lines is a deliberate break, not a gap.
                    after_orn = any(c["x1"] - c["x0"] < 5 and prev.y < c["top"] < l.y for c in p.curves)
                    if not gap_ok and after_orn:
                        gap_ok = True
                    res.check("BODY-PITCH" if d < 23 else "BODY-PARA-GAP", pitch_ok or gap_ok, f"p{pno}: {d} '{snip(l)}'")
                    in_dropcap = opener and any(x.kind == "dropcap" for x in content) and l.x > LEFT + 2 and i < 8
                    if gap_ok:
                        want = LEFT if after_orn else LEFT + INDENT  # flush after a section ornament, like after a heading
                        res.check("BODY-INDENT", near(l.x, want, 0.5), f"p{pno}: new paragraph at x={l.x:.1f} (want {want}) '{snip(l)}'")
                    elif pitch_ok and not in_dropcap:
                        res.check("BODY-INDENT", near(l.x, LEFT, 0.5) or near(l.x, LEFT + INDENT, 0.5), f"p{pno}: x={l.x:.1f} '{snip(l)}'")
                elif prev.kind == "heading":
                    res.check("HEAD-AFTER", near(d, R["HEAD-AFTER"]["target"], R["HEAD-AFTER"]["tol"]), f"p{pno}: {d} after '{snip(prev)}'")
                    res.check("BODY-INDENT", near(l.x, LEFT, 0.5), f"p{pno}: first line after heading indented '{snip(l)}'")
                elif prev.kind in ("boxbody", "boxnote", "boxhead", "table"):  # text beside a drop cap is the same paragraph
                    res.check("BODY-INDENT", near(l.x, LEFT + INDENT, 0.5), f"p{pno}: paragraph after {prev.kind} not indented '{snip(l)}'")
        # TABLE-ONE-PAGE
        if any(l.kind == "table" and l.text.replace(" ", "").upper() == "DATE" or l.text.replace(" ", "").upper().startswith("DATETOTAL") for l in lines):
            rows = [l for l in lines if l.kind == "table" and l.fam == "Inter" and re.match(r"(AUG|EOY|FEB|JAN|JUL|JUN|MAR|APR|MAY|SEP|OCT|NOV|DEC)\d{4}", l.text.replace(" ", "").upper())]
            res.check("TABLE-ONE-PAGE", len(rows) >= 9, f"p{pno}: only {len(rows)} table rows on the table's first page")
    if boxes_in_chapter:
        ws = [i for i, (_, _, _, h) in enumerate(boxes_in_chapter) if h.startswith("YOURWORKSHEET")]
        res.check("BOX-WORKSHEET-LAST", bool(ws) and ws[-1] == len(boxes_in_chapter) - 1,
                  f"box order: {[h[:14] for _, _, _, h in boxes_in_chapter]}")
        for i in range(len(boxes_in_chapter) - 1):
            pa, _, ba, ha = boxes_in_chapter[i]
            pb, tb, _, hb = boxes_in_chapter[i + 1]
            between = 0
            for p in range(pa, pb + 1):
                for y in body_pos.get(p, []):
                    if p == pa == pb and ba < y < tb:
                        between += 1
                    elif pa == pb:
                        continue
                    elif p == pa and y > ba:
                        between += 1
                    elif p == pb and p != pa and y < tb:
                        between += 1
                    elif pa < p < pb:
                        between += 1
            res.check("BOX-SEPARATION", between >= 3,
                      f"p{pa}({ha[:14]}) -> p{pb}({hb[:14]}): {between} body lines between")
    page_gap_check(page_info, body_pos, boxes_in_chapter, first, last, res)
    takeaway_orphan_check(page_info, first, last, res)


# ---------------------------------------------------------------- source lint
def chapter_src_ranges(lines):
    starts = {}
    cut = len(lines)
    for i, l in enumerate(lines):
        if "// BACK COVER" in l:
            cut = i
        m = re.search(r'#chaphead\("Chapter (\w+)"', l)
        if m:
            starts[m.group(1)] = i
    order = sorted(starts.items(), key=lambda kv: kv[1])
    return {n: (s, order[k + 1][1] if k + 1 < len(order) else cut) for k, (n, s) in enumerate(order)}


def check_src(lines, a, b, res):
    fence = sum(1 for l in lines[:a] if l.startswith("```")) % 2 == 1
    depth = 0
    ws_depth = None
    for i in range(a, b):
        l, n = lines[i], i + 1
        if "```" in l and l.strip() not in ("```", "```{=typst}"):
            res.check("SRC-FENCE-LINE", False, f"line {n}: {l.strip()[:50]}")
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
            if "#highlight(" in l:
                res.check("SRC-HIGHLIGHT", False, f"line {n}")
            if re.match(r"#(set|show)\b", stripped):
                res.check("SRC-TOPLEVEL-SET", depth > 0, f"line {n}: {stripped[:50]}")
            if re.match(r"#v\(", stripped) and depth == 0:
                res.check("SRC-MANUAL-SPACE", False, f"line {n}: {stripped[:40]}")
            if "#block(above: 0pt" in code:
                res.check("SRC-ABOVE0", False, f"line {n}")
            if re.search(r"#par\((?:leading|spacing):", code) or re.search(r"#set\s+par\(", code):
                res.check("SRC-PAR-OVERRIDE", False, f"line {n}: {stripped[:50]}")
            if "#worksheet(" in code:
                ws_depth = depth
            if ws_depth is not None and re.search(r"#stack\(|#grid\(|^\s*\d+\.\s", code):
                res.check("SRC-HANDBUILT-LIST", False, f"line {n}: {stripped[:50]}")
            depth += code.count("[") - code.count("]")
            if ws_depth is not None and depth <= ws_depth:
                ws_depth = None
        else:
            body = l.strip()
            if "#highlight(" in l:
                res.check("SRC-HIGHLIGHT", False, f"line {n}")
            if re.search(r"\S {2,}\S", body):
                res.check("SRC-DOUBLE-SPACE", False, f"line {n}: '{body[:60]}'")
            prev = lines[i - 1] if i else ""
            if re.match(r"^\s{2,}[A-Z]", l) and prev.strip() and not prev.startswith("#") and re.search(r"[.?!”\"}]$", prev.rstrip()):
                res.check("SRC-MERGED-PARA", False, f"line {n}: '{body[:50]}'")
    for rid in ("SRC-MANUAL-SPACE", "SRC-TOPLEVEL-SET", "SRC-ABOVE0", "SRC-PAR-OVERRIDE",
                "SRC-HANDBUILT-LIST", "SRC-DOUBLE-SPACE", "SRC-MERGED-PARA", "SRC-FENCE",
                "SRC-FENCE-LINE", "SRC-HIGHLIGHT"):
        res.check(rid, True)


# ---------------------------------------------------------------- main
def backcover_phrase():
    lines = MS.read_text().split("\n")
    seen = False
    for l in lines:
        if "// BACK COVER" in l:
            seen = True
            continue
        if seen:
            mk = __import__("book_config").CFG.get("backcover_marker")
            m = re.search(r"\b" + re.escape(mk) + r"\b", l) if mk else None
            if m:
                return m.group(0).replace(" ", "").upper()
    return None


def pdf_chapter_ranges(pdf):
    openers = {}
    back = None
    phrase = backcover_phrase()
    for i, p in enumerate(pdf.pages):
        t = "".join(c["text"] for c in p.chars).replace(" ", "").upper()
        if back is None and phrase and phrase in t:
            back = i
        for w in NUMWORDS:
            if t.startswith(f"CHAPTER{w.upper()}") and w not in openers:  # openers begin with it; prose mentions ("chapter five is…") must not count
                openers[w] = i + 1
    order = sorted(openers.items(), key=lambda kv: kv[1])
    out = {}
    for k, (w, s) in enumerate(order):
        e = order[k + 1][1] - 1 if k + 1 < len(order) else len(pdf.pages)
        if back is not None and e > back:
            e = back  # back is the 0-based index of the back-cover page, i.e. the 1-based number of the page before it
        out[w] = (s, e)
    return out


def check_frontmatter(pdf, pr, res):
    fails = []
    cpage = None
    one = pr.get("One")
    limit = one[0] if one else len(pdf.pages)
    for i, p in enumerate(pdf.pages[:limit]):
        t = "".join(c["text"] for c in p.chars).replace(" ", "").upper()
        if "CONTENTS" in t:
            cpage = i + 1
            break
    if cpage:
        lines, _ = page_model(pdf.pages[cpage - 1])
        fols = [l.text.strip() for l in lines if l.kind == "folio"]
        if not any(re.fullmatch(r"[ivxlcdm]+", f) for f in fols):
            fails.append(f"p{cpage}: contents page lacks lowercase roman folio")
    else:
        fails.append("contents page not found")
    if one:
        pre = one[0] - 1
        if pre >= 1:
            lines, _ = page_model(pdf.pages[pre - 1])
            fols = [l.text.strip() for l in lines if l.kind == "folio"]
            if any(f.isdigit() for f in fols):
                fails.append(f"p{pre}: arabic folio before Ch One opener")
        post = one[0] + 1
        if post <= len(pdf.pages):
            lines, _ = page_model(pdf.pages[post - 1])
            fols = [l.text.strip() for l in lines if l.kind == "folio"]
            if "2" not in fols:
                fails.append(f"p{post}: folio '2' missing after Ch One opener")
    else:
        fails.append("Ch One range not found")
    res.check("FRONTMATTER-FOLIO", not fails, "; ".join(fails))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--chapters", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    pdf = pdfplumber.open(a.pdf)
    src = MS.read_text().split("\n")
    pr, sr = pdf_chapter_ranges(pdf), chapter_src_ranges(src)
    # IMG-UNIQUE: book-wide duplicate scan, reported under the chapter holding the 2nd use
    img_uses = {}
    for path, line in img_unique_uses(src):
        img_uses.setdefault(path, []).append(line)
    img_fail_by_ch = defaultdict(list)
    for path, ls in img_uses.items():
        if len(ls) < 2:
            continue
        ch = next((c for c, (s, e) in sr.items() if s <= ls[1] <= e), a.chapters.split(",")[0])
        img_fail_by_ch[ch].append(f"{path} used {len(ls)}x (lines {', '.join(map(str, ls))})")
    out = [f"# Book QA report — `{Path(a.pdf).name}`", "", f"Rule set: `{RULES['adr']}` v{RULES['version']}", ""]
    blockers = 0
    unknown = [c for c in a.chapters.split(",") if c not in pr]
    if unknown:  # e.g. "3" instead of "Three" would otherwise run zero checks and report PASS
        sys.exit(f"book_qa: unknown chapter name(s) {unknown}; use {list(pr)}")
    for ch in a.chapters.split(","):
        res = Results()
        if ch in pr:
            s, e = pr[ch]
            # proof builds cut before the next chapter: ignore trailing pages after the chapter's last content page
            if e == len(pdf.pages):
                e = last_content_page(pdf, s, e)
            # stop at the chapter's last page before any photo/part page: last page with body text is fine either way
            check_pdf(pdf, s, e, res, None)
            if ch in sr:
                body_merged_check(pdf, s, e, src, sr[ch][0], sr[ch][1], res)
        if ch == a.chapters.split(",")[0]:
            check_frontmatter(pdf, pr, res)
        if ch in sr:
            check_src(src, *sr[ch], res)
        for m in img_fail_by_ch.get(ch, []):
            res.check("IMG-UNIQUE", False, m)
        res.check("IMG-UNIQUE", True)
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
