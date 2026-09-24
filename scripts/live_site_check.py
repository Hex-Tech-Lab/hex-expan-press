#!/usr/bin/env python3
"""Site-vs-config check (blind-spot audit 2026-09-25, risks 3 + 8). Fetches the product pages
(live expanpress.com by default, or the local build with --local) and asserts:
  - the price shown equals payments/config.duane.json price_usd, and no other $ price appears in a price slot
  - the product title equals config title
  - every primary buy button stays gated while config checkout_mode != "live" (legal gate 2026-09-14)
Writes <QA>/live_site_report.md (+ .html). Exit 1 on any mismatch. Read-only.

Usage: python3 scripts/live_site_check.py [--local]
"""
import argparse
import html
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA, REPO  # noqa: E402

CFG = json.loads((REPO / "payments/config.duane.json").read_text())  # the site's config, not the book's
BASE = "https://expanpress.com"
PAGES = {"/": "index.html",
         "/c/retirearly500k/": "c/retirearly500k/index.html",
         f"/c/{CFG['site_slug']}/": f"c/{CFG['site_slug']}/index.html"}
PRICE_SLOT = re.compile(r'class="(?:price|card-price)">\$(\d+)')
TITLE_SLOT = re.compile(r"<h1>(.*?)</h1>|class=\"cover-title\">(.*?)</p>", re.S)
HEAD_TITLE = re.compile(r"<title>(.*?)(?: — [^<]*)?</title>", re.S)  # " — with Duane" suffix allowed
SOCIAL_TITLE = re.compile(r'<meta (?:property|name)="(?:og|twitter):title" content="([^"]*)"')
DESC_PRICE = re.compile(r'<meta (?:property|name)="(?:og:|twitter:)?description" content="[^"]*?\$(\d+)\.')
PRIMARY = re.compile(r'<a[^>]*data-checkout-slot="primary"[^>]*>')


def fetch(path, local):
    if local:
        return (REPO / "payments/site" / PAGES[path]).read_text()
    req = urllib.request.Request(BASE + path + "?nocache=1", headers={"User-Agent": "expan-site-check"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true")
    args = ap.parse_args()
    want_price, want_title, mode = str(CFG["price_usd"]), CFG["title"], CFG["checkout_mode"]
    out = [f"# SITE CHECK — {'local build' if args.local else BASE}", "",
           f"config: price=${want_price}, title=\"{want_title}\", checkout_mode={mode}", ""]
    fails = 0
    for path in PAGES:
        try:
            page = fetch(path, args.local)
        except Exception as e:  # noqa: BLE001
            out.append(f"- **FAIL** {path}: could not fetch ({e})")
            fails += 1
            continue
        probs = []
        prices = PRICE_SLOT.findall(page)
        if not prices:
            probs.append("no price slot found")
        probs += [f"price ${p} != ${want_price}" for p in prices if p != want_price]
        # the creator hub's <h1>/<title>/og are the creator's; only its product cover carries the book title
        hub = path == "/c/retirearly500k/"
        titles = []
        for h1, cover in TITLE_SLOT.findall(page):
            if hub and not cover:
                continue
            titles.append(("title", cover or h1))
        if not hub:
            titles += [("<title>", t) for t in HEAD_TITLE.findall(page)]
            titles += [("og/twitter title", t) for t in SOCIAL_TITLE.findall(page)]
            probs += [f"meta description says ${p} != ${want_price}"
                      for p in DESC_PRICE.findall(page) if p != want_price]
        for where, t in titles:
            t = html.unescape(re.sub(r"<[^>]+>", "", t)).strip().replace("’", "'")
            if t != want_title:
                probs.append(f"{where} \"{t}\" != config")
        if mode != "live":
            for a in PRIMARY.findall(page):
                if 'data-checkout-mode="gated"' not in a or 'href="#buy-link-pending"' not in a:
                    probs.append("primary buy button NOT gated while checkout_mode != live")
        fails += bool(probs)
        out.append(f"- **{'FAIL' if probs else 'PASS'}** {path}" + (": " + "; ".join(probs) if probs else ""))
    out += ["", f"TOTAL: {fails} page(s) failing of {len(PAGES)}"]
    rep = QA / ("live_site_report_local.md" if args.local else "live_site_report.md")
    rep.write_text("\n".join(out) + "\n")
    subprocess.run(["bash", "scripts/render_report.sh", str(rep)], cwd=REPO)
    print("\n".join(out[-len(PAGES) - 2:]))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
