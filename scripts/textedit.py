"""Shared text-edit helper (lesson M-15): whitespace-tolerant exact replacement.

`rep(text, old, new)` matches `old` against `text` treating any run of
whitespace (spaces, tabs, newlines) as equivalent — so a phrase wrapped
across two lines still matches — but raises RepError unless the match is
UNIQUE. Never silently replaces the wrong instance or nothing at all.
"""
import re


class RepError(ValueError):
    pass


def rep(text: str, old: str, new: str) -> str:
    """Replace exactly one whitespace-tolerant occurrence of `old` with `new`.

    Raises RepError on: empty/whitespace-only `old`, zero matches, or more
    than one match. Whitespace inside `old` may differ from the text (the
    text may even wrap the phrase across lines); the replacement spans from
    the first to the last token of the match, leaving surrounding
    whitespace/punctuation intact.
    """
    toks = old.split()
    if not toks:
        raise RepError("rep(): empty search string")
    pat = r"\s+".join(re.escape(t) for t in toks)
    ms = list(re.finditer(pat, text))
    if len(ms) != 1:
        raise RepError(f"rep(): expected exactly 1 match for {old[:60]!r}, found {len(ms)}")
    m = ms[0]
    return text[:m.start()] + new + text[m.end():]
