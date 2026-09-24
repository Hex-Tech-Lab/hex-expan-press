#!/usr/bin/env python3
"""Apply creator-review highlight marks to a COPY of the manuscript.

Usage: review_marks.py IN_MD MARKS_JSON OUT_MD

MARKS_JSON: [{"id": "...", "span": "exact text or null"}, ...]
Never writes to IN_MD. Wraps each non-null span (must occur exactly once,
else SKIP + id) in a Typst highlight:
  - span inside a ```{=typst} fence:  #highlight(fill: rgb("#FFF200"))[<span>]
  - otherwise: `#highlight(fill: rgb("#FFF200"))[`{=typst}<span>`]`{=typst}
"""
import json
import sys

HILITE = '#highlight(fill: rgb("#FFF200"))['
OPEN = '```{=typst}'


def main() -> int:
    in_md, marks_path, out_md = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(in_md, encoding='utf-8') as f:
        text = f.read()
    with open(marks_path, encoding='utf-8') as f:
        marks = json.load(f)
    marks = marks.get("marks", []) if isinstance(marks, dict) else marks

    for mark in marks:
        mid = mark.get('id', '?')
        span = mark.get('span')
        if span is None:
            print(f'SKIP {mid}: null span')
            continue
        count = text.count(span)
        if count != 1:
            print(f'SKIP {mid}: found {count} occurrences')
            continue
        pos = text.index(span)
        line_start = text.rfind('\n', 0, pos) + 1
        before = text[:line_start]
        depth = 0
        for line in before.splitlines():
            s = line.strip()
            if s == OPEN:
                depth += 1
            elif s == '```' and depth > 0:
                depth -= 1
        if depth > 0:
            repl = f'{HILITE}{span}]'
        else:
            repl = f'`{HILITE}`{{=typst}}{span}`]`{{=typst}}'
        text = text[:pos] + repl + text[pos + len(span):]
        where = 'fence' if depth > 0 else 'prose'
        print(f'MARKED {mid}: {where}')

    with open(out_md, 'w', encoding='utf-8') as f:
        f.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
