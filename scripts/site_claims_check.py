#!/usr/bin/env python3
"""Public-site claims gate (T37-W1b, H1+D3+D4). READ-ONLY over payments/site/**/*.html and
payments/landing/**/*.html. Strips each page to visible text, pre-filters sentences carrying a claim
(number, $, "you will", guarantee/retire/income/return/risk/proven) and asks Jev three noul questions:
  supported_by_book      - is the claim backed by the book? (context: page title + previous sentence,
                           plus the 3 most keyword-similar book sentences from chapter prose)
  specific_recommendation and guarantee_claim - reused verbatim from compliance_check.py
Report per page: UNSUPPORTED (supported_by_book < 0.5), ADVICE/GUARANTEE (>=0.8 BLOCK, 0.5-0.8 FLAG),
and whether a not-financial-advice disclaimer appears in the page's plain text.
Never edits the site. Writes <QA>/site_claims_report.md (+ .html via render_report.sh).

Usage: python3 scripts/site_claims_check.py [--no-jev]
"""
import html
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
from book_config import QA, chapter_sources  # noqa: E402
from literary_metrics import prose  # noqa: E402
from jev import decide  # noqa: E402

LO, HI = 0.5, 0.8
QUESTIONS = {
    "supported_by_book": {"type": "noul",
        "instructions": "Considering the page title, the previous sentence and the BOOK EXCERPTS given, "
                        "is the claim in this sentence supported, taught or substantiated anywhere in the book?",
        "criteria": {"true": "The book states, teaches or substantiates this claim or the underlying idea.",
                     "false": "The book never says anything like this; the claim appears only on the site."}},
    "specific_recommendation": {"type": "noul",
        "instructions": "Does this sentence recommend that THE READER buy, sell or hold a specific named security, fund, "
                        "annuity product or provider, or adopt a specific portfolio allocation for their own money? "
                        "General habits (save, keep cash, take the employer match, budget arithmetic) do NOT count. "
                        "Use CONTEXT: if it is framed as the author's own rule or choice, it does not count.",
        "criteria": {"true": "It recommends a specific investment product, security, provider or allocation to the reader.",
                     "false": "It is a general habit, arithmetic, the author's own choice, or a story."}},
    "guarantee_claim": {"type": "noul",
        "instructions": "Does it promise or imply a guaranteed or certain financial outcome for the reader?",
        "criteria": {"true": "It promises, implies or predicts a certain/assured financial result.",
                     "false": "No guaranteed outcome is promised or implied."}},
}
CLAIM = re.compile(
    r"\$|\b\d[\d.,%]*\b"
    r"|\byou will\b|\bwill\b.*\b(you|your)\b"
    r"|\bguarantee|guaranteed\b|\bproven\b|\brisk\b|\brisk-free\b"
    r"|\bretire|\bincome\b|\breturn|\breturns\b|\bprofit|\bmoney\b", re.I)
DISCLAIMER = re.compile(r"not\s+(?:financial|investment)\s+advice|financial\s+advice", re.I)
TAG = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.I | re.S)
TAG_ANY = re.compile(r"<[^>]+>")

STOP = set("the a an and or of to in on for with your you it is are was were be been this that as at from by not but if "
           "we i my our their his her them they he she will can what how why do does did have has had".split())


def strip_html(text):
    text = TAG.sub(" ", text)
    text = html.unescape(TAG_ANY.sub(" ", text))
    return re.sub(r"\s+", " ", text)


def sentences(text):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z\"'$0-9])", text) if 4 <= len(s.split()) <= 80]


def toks(s):
    return {w for w in re.findall(r"[a-z']+", s.lower()) if w not in STOP and len(w) > 3}


def book_corpus():
    """All chapter prose sentences (book side, via book_config.chapter_sources + literary_metrics.prose)."""
    out = []
    for name, title, src in chapter_sources():
        for s in sentences(prose(src)):
            out.append((name, s, toks(s)))
    return out


def similar(claim_toks, corpus, k=3):
    scored = sorted(corpus, key=lambda r: -len(claim_toks & r[2]))[:k]
    return [f'"{s[:220]}" (Ch{ch})' for ch, s, t in scored]


def pages():
    for d in ("web", "payments/landing"):
        yield from sorted((REPO / d).rglob("*.html"))


# Audit risk 9: separate lines the book can never back (legal pages, price/checkout/tax/refund mechanics,
# the creator bio, whose owner is creators.json bio_source) from real product claims. Only the latter
# stay UNSUPPORTED and need triage.
POLICY_PAGES = {"privacy.html", "terms.html", "refund-policy.html"}
NOT_BOOK = re.compile(r"\$\d+ USD|one-time|checkout|sales tax|VAT|refund|support@|payment partner"
                      r"|we respond|last updated", re.I)


def owner_of(page, sentence):
    # short lines only: a long merged sentence may carry a real content claim next to "checkout"
    if page.name in POLICY_PAGES or (len(sentence) < 160 and NOT_BOOK.search(sentence)):
        return "NOT-BOOK (policy/price)"
    # only sentences that are part of a creator's bio text (creators.json), never the whole hub page
    tail = _norm(sentence)[-80:]
    if len(tail) >= 30 and any(tail in b for b in BIOS):
        return "NOT-BOOK (creator bio)"
    return None


def _norm(s):
    return re.sub(r"\s+", " ", html.unescape(s)).replace("’", "'").strip()


BIOS = [_norm(c.get("bio", "")) for c in
        json.loads((REPO / "payments/creators.json").read_text()).get("creators", [])]


def main():
    use_jev = "--no-jev" not in sys.argv
    corpus = book_corpus()
    report, tot = [], {"BLOCK": 0, "FLAG": 0, "UNSUPPORTED": 0, "UNCHECKED": 0, "NOT-BOOK": 0}
    for p in pages():
        text = strip_html(p.read_text(errors="replace"))
        title_m = re.search(r"<title>(.*?)</title>", p.read_text(errors="replace"), re.I | re.S)
        title = strip_html(title_m.group(1)) if title_m else p.name
        disclaim = bool(DISCLAIMER.search(text))
        rows = []
        sents = sentences(text)
        for i, s in enumerate(sents):
            if not CLAIM.search(s):
                continue
            ctx = f"Page: {title}. Previous: {sents[i-1]}" if i else f"Page: {title}."
            exc = similar(toks(s), corpus)
            if not use_jev:
                rows.append((s, None, "UNCHECKED (Jev off)", exc)); continue
            a = decide({"context": ctx, "sentence": s, "book_excerpts": exc}, QUESTIONS, timeout=20)
            if a is None:
                rows.append((s, None, "UNCHECKED (Jev unavailable)", exc)); continue
            sup, rec, gar = (a["supported_by_book"]["noul"], a["specific_recommendation"]["noul"],
                             a["guarantee_claim"]["noul"])
            if max(rec, gar) >= HI:
                v = "BLOCK"
            elif max(rec, gar) >= LO:
                v = "FLAG"
            elif sup < LO:
                v = owner_of(p, s) or "UNSUPPORTED"
            else:
                v = "PASS"
            rows.append((s, max(rec, gar), v, exc))
        for v in ("BLOCK", "FLAG", "UNSUPPORTED"):
            tot[v] += sum(r[2] == v for r in rows)
        tot["UNCHECKED"] += sum(r[2].startswith("UNCHECKED") for r in rows)
        tot["NOT-BOOK"] += sum(r[2].startswith("NOT-BOOK") for r in rows)
        report.append((p.relative_to(REPO), title, disclaim, rows))
    out = ["# SITE CLAIMS — public-page gate (T37-W1b, H1+D3+D4)", ""]
    for rel, title, disclaim, rows in report:
        nb = sum(r[2] == "BLOCK" for r in rows)
        nf = sum(r[2] == "FLAG" for r in rows)
        nu_ = sum(r[2] == "UNSUPPORTED" for r in rows)
        nunc = sum(r[2].startswith("UNCHECKED") for r in rows)
        out.append(f"## {rel} — \"{title}\"")
        out.append(f"{len(rows)} claim sentences: {nb} BLOCK, {nf} FLAG, {nu_} UNSUPPORTED, {nunc} UNCHECKED. "
                   f"Disclaimer present: {'YES' if disclaim else 'NO'}")
        out.append("")
        for s, p, v, exc in rows:
            out.append(f"- **{v}**{'' if p is None else f' (p={p:.2f})'}: {s}")
            if v in ("BLOCK", "FLAG", "UNSUPPORTED"):
                for e in exc:
                    out.append(f"  - book: {e}")
        out.append("")
    out.append(f"## TOTALS — {tot['BLOCK']} BLOCK, {tot['FLAG']} FLAG, {tot['UNSUPPORTED']} UNSUPPORTED, "
               f"{tot['UNCHECKED']} UNCHECKED, {tot['NOT-BOOK']} NOT-BOOK (not a book claim; owned by legal/config)")
    rep = QA / "site_claims_report.md"
    rep.write_text("\n".join(out))
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)])
    print(f"SITE-CLAIMS: {tot['BLOCK']} BLOCK, {tot['FLAG']} FLAG, {tot['UNSUPPORTED']} UNSUPPORTED, "
          f"{tot['UNCHECKED']} UNCHECKED, {tot['NOT-BOOK']} NOT-BOOK -> {rep}")
    print(f"Disclaimer: " + "; ".join(f"{rel}={disclaim}" for rel, _, disclaim, _ in report))


if __name__ == "__main__":
    main()
