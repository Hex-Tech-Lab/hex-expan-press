#!/usr/bin/env python3
"""layout_fixers.py — rule-driven, line-based fixers for manuscript.md chapters.

Usage: layout_fixers.py <Ch> [--dry-run|--apply] [--manuscript PATH] [--no-jev]

Operates ONLY on the slice of manuscript.md from `#chaphead("Chapter <Ch>"` to
the next `#chaphead(` (or `// BACK COVER`). --dry-run (default) prints a unified
diff + per-fixer counts; --apply backs up to <QA>/revisions/manuscript_before_fix_<Ch>_<stamp>.md,
writes, prints the counts. The orchestrator decides when to run --apply.

Python 3 stdlib only.
"""
import argparse
import datetime
import difflib
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import MS, QA, CHAPTERS
from jev import decide

REVISIONS = QA / "revisions"
BOX_NAMES = ("#callout", "#worksheet", "#sidebar", "#corroborated")
FIX_IDS = ["SRC-HANDBUILT-LIST", "SRC-MANUAL-SPACE", "SRC-ABOVE0",
           "SRC-PAR-OVERRIDE", "BODY-INDENT", "SRC-DOUBLE-SPACE", "SRC-HIGHLIGHT"]
FENCE_OPEN = "```{=typst}"
FENCE_CLOSE = "```"

# Guards: in-fence lines that must never receive a #h(14pt) prefix.
NO_PREFIX = re.compile(
    r"^(?:#h\(|#dropcap\(|#heading\(|#chaphead\(|#pagebreak|#v\(|#block\("
    r"|#grid\(|#figure|#list\(|#enum\(|"
    + "|".join(re.escape(n) + r"\(" for n in BOX_NAMES) + r")")


# ---------------------------------------------------------------- slice / fences

def find_slice(lines, ch):
    """(start, end) half-open indices of the chapter slice; raises if missing."""
    start = end = None
    for i, line in enumerate(lines):
        if start is None:
            if f'#chaphead("Chapter {ch}"' in line:
                start = i
        else:
            if "#chaphead(" in line or line.strip().startswith("// BACK COVER"):
                end = i
                break
    if start is None:
        raise SystemExit(f"BLOCKED: no #chaphead(\"Chapter {ch}\" in manuscript")
    if end is not None:
        # The slice must end BEFORE the fence that contains the next #chaphead
        # (or // BACK COVER marker): walk back out of any enclosing fence so the
        # dangling fence-open never becomes an unterminated block in this slice.
        states = fence_states(lines)
        while end > start and states[end] is True:
            end -= 1
    return start, (end if end is not None else len(lines))


def fence_states(lines):
    """Per line: 'open' / 'close' marker, or bool in_fence (True inside)."""
    states, in_f = [], False
    for line in lines:
        s = line.strip()
        if s == FENCE_OPEN:
            in_f = True
            states.append("open")
        elif in_f and s == FENCE_CLOSE:
            in_f = False
            states.append("close")
        else:
            states.append(in_f)
    return states


def inside(states, i):
    return states[i] is True


def fence_blocks(lines, states):
    """[(open_i, content_start, content_end, close_i)] half-open content span."""
    blocks, i, n = [], 0, len(lines)
    while i < n:
        if states[i] == "open":
            j = i + 1
            while j < n and states[j] != "close":
                j += 1
            blocks.append((i, i + 1, j, j if j < n else None))
            i = j + 1
        else:
            i += 1
    return blocks


# ---------------------------------------------------------------- edit application

def apply_edits(lines, edits):
    """edits: list of (start, end, replacement_lines) half-open; reverse order."""
    for start, end, repl in sorted(edits, key=lambda e: (e[0], e[1]), reverse=True):
        lines[start:end] = repl
    return lines


# ---------------------------------------------------------------- Jev prose-hunk gate (T33-J3)

MARKUP_SPAN = re.compile(r"`[^`]*`\{=typst\}")
TYPS_CALL = re.compile(r"#\w+(?:\((?:[^()]|\([^()]*\))*\))?")

MEANING_Q = {"changes_meaning": {
    "type": "noul",
    "instructions": "A layout fixer rewrote part of a manuscript. Does AFTER change the meaning of BEFORE "
                    "(new/lost claims, facts, advice, examples or tone), as opposed to only reformatting, "
                    "re-listing or re-wrapping the same words?",
    "criteria": {"true": "the meaning changed", "false": "only formatting/structure changed; same words and meaning"}}}


def prose_of(lines):
    """Markup/whitespace-free prose view of a hunk (fences, typst calls, list
    markers, escapes stripped; whitespace collapsed). Pure-markup hunks compare equal."""
    s = "\n".join(lines)
    s = re.sub(r"^```.*$", "", s, flags=re.M)
    s = MARKUP_SPAN.sub("", s)
    s = TYPS_CALL.sub(" ", s)
    s = s.replace("\\[", "[").replace("\\]", "]").replace("\\_", "_").replace("\\$", "$").replace("\\", "")
    s = re.sub(r"[\[\]`*{}]", " ", s)
    s = re.sub(r"^[-*] |\d+\. ", " ", s, flags=re.M)
    return re.sub(r"\s+", " ", s).strip()


def gate_prose_hunks(lines, edits, notes, use_jev):
    """T33-J3 point 1: a hunk that changes PROSE (not pure markup/whitespace) must
    pass Jev changes_meaning: p >= 0.5 (0.8 auto / 0.5-0.8 + FLAG) -> DROP the hunk;
    p < 0.5 -> keep; Jev unavailable -> keep (current behaviour) and mark UNCHECKED."""
    kept = []
    for start, end, repl in edits:
        before, after = prose_of(lines[start:end]), prose_of(repl)
        if before == after or not use_jev:
            kept.append((start, end, repl))
            continue
        a = decide({"before": before, "after": after}, MEANING_Q, timeout=20)
        p = a["changes_meaning"]["noul"] if a else None
        if p is None:
            kept.append((start, end, repl))
            notes.append(f"JEV-UNCHECKED: prose hunk lines {start + 1}-{end} KEPT (Jev unavailable; current behaviour)")
        elif p >= 0.5:
            notes.append(f"JEV-DROP{' (FLAG)' if p < 0.8 else ''}: prose hunk lines {start + 1}-{end} DROPPED, changes_meaning={p:.2f}")
        else:
            kept.append((start, end, repl))
            notes.append(f"JEV-KEEP: prose hunk lines {start + 1}-{end} kept, changes_meaning={p:.2f}")
    return kept


# ---------------------------------------------------------------- fixer 1: hand-built lists

BULLET = re.compile(r"^[-*] ")
ENUM = re.compile(r"^\d+\. ")


def fix_handbuilt_lists(lines):
    """Run of >=2 consecutive markdown bullets/enums outside fences -> typst fence;
    the same inside a #worksheet(...) body -> inline #enum( in that body."""
    edits = handbuilt_runs_outside_fences(lines) + worksheet_enum_runs(lines)
    return edits


def handbuilt_runs_outside_fences(lines):
    states = fence_states(lines)
    edits = []
    i, n = 0, len(lines)
    while i < n:
        if inside(states, i) or states[i] in ("open", "close"):
            i += 1
            continue
        is_enum = bool(ENUM.match(lines[i]))
        if not (BULLET.match(lines[i]) or is_enum):
            i += 1
            continue
        items, run_end, cur = [], None, None
        j = i
        while j < n and not inside(states, j) and states[j] not in ("open", "close"):
            line = lines[j]
            if BULLET.match(line) and not is_enum:
                cur = line[2:].strip()
                items.append([cur])
                run_end = j + 1
            elif ENUM.match(line) and is_enum:
                m = ENUM.match(line)
                cur = line[m.end():].strip()
                items.append([cur])
                run_end = j + 1
            elif line.strip() and line[:1] in (" ", "\t") and items:
                items[-1].append(line.strip())
                run_end = j + 1
            else:
                break
            j += 1
        if len(items) >= 2:
            fn = "#enum(" if is_enum else "#list("
            body = fn + "\n"
            for parts in items:
                text = " ".join(parts).replace("[", r"\[").replace("]", r"\]")
                body += f"  [{text}],\n"
            body += ")"
            repl = [FENCE_OPEN] + body.split("\n") + [FENCE_CLOSE]
            edits.append((i, run_end, repl))
            i = run_end
        else:
            i = j if j > i else i + 1
    return edits


def worksheet_enum_runs(lines):
    """Hand-built `1. text` / `2. text` runs inside a #worksheet(...) body ->
    inline #enum( ... ) in the same body (modeled on Chapter One's worksheet)."""
    states = fence_states(lines)
    edits = []
    for open_i, cs, ce, close_i in fence_blocks(lines, states):
        first = next((lines[k].strip() for k in range(cs, ce) if lines[k].strip()), "")
        if first.startswith("#let "):
            continue  # component definition fence — never edit
        content_lines = lines[cs:ce]
        offsets, pos = [], 0
        for line in content_lines:
            offsets.append(pos)
            pos += len(line) + 1
        text = "\n".join(content_lines)
        for m in re.finditer(r"#worksheet\s*\(", text):
            i, d = m.end(), 1  # balance the worksheet(...) arguments
            while i < len(text) and d > 0:
                c = text[i]
                if c == "\\":
                    i += 2
                    continue
                if c == "(":
                    d += 1
                elif c == ")":
                    d -= 1
                i += 1
            j = text.find("[", i)
            if j == -1:
                continue
            k, bd = j, 0  # find the body's closing ']'
            while k < len(text):
                c = text[k]
                if c == "\\":
                    k += 2
                    continue
                if c == "[":
                    bd += 1
                elif c == "]":
                    bd -= 1
                    if bd == 0:
                        break
                k += 1
            if bd != 0:
                continue
            s0, s1 = j + 1, k  # body content spans [s0, s1); text[s1] == ']'
            items, run_start, run_end = [], None, None
            li = cs
            while li < ce and not ENUM.match(content_lines[li - cs]):
                li += 1
            while li < ce and offsets[li - cs] < s1:
                line = content_lines[li - cs]
                em = ENUM.match(line)
                li_end = offsets[li - cs] + len(line)
                if em:
                    txt = (text[offsets[li - cs] + em.end():s1] if s1 < li_end
                           else line[em.end():])
                    items.append([txt.strip()])
                    run_start = run_start if run_start is not None else li
                    run_end = li + 1
                elif not line.strip():
                    pass  # blank separator between items
                elif line[:1] in (" ", "\t") and line.strip() != "]" and items:
                    txt = (text[offsets[li - cs]:s1] if s1 < li_end else line)
                    items[-1].append(txt.strip())
                    run_end = li + 1
                else:
                    break
                li += 1
            if len(items) < 2 or run_start is None:
                continue
            body_out = ["#enum("]
            for parts in items:
                t = " ".join(parts).replace("[", r"\[").replace("]", r"\]")
                body_out.append(f"  [{t}],")
            body_out.append(")")
            if s1 < offsets[run_end - 1 - cs] + len(content_lines[run_end - 1 - cs]):
                body_out.append("  ]")  # worksheet ']' sat on the last run line
            if body_out != content_lines[run_start:run_end]:
                edits.append((run_start, run_end, body_out))
    return edits


# ---------------------------------------------------------------- fixer 2: manual space

V_LINE = re.compile(r"^#v\(\d+(?:\.\d+)?pt\)$")


def callout_worksheet_covered(text):
    """Boolean char array of text covered by #worksheet/#callout spans."""
    covered = [False] * len(text)
    for m in re.finditer(r"#(?:worksheet|callout)\(", text):
        i, d = m.end(), 1
        while i < len(text) and d > 0:
            c = text[i]
            if c == "(":
                d += 1
            elif c == ")":
                d -= 1
            i += 1
        j = text.find("[", i)
        if j == -1:
            continue
        k, bd = j, 0
        while k < len(text):
            c = text[k]
            if c == "\\":
                k += 2
                continue
            if c == "[":
                bd += 1
            elif c == "]":
                bd -= 1
                if bd == 0:
                    break
            k += 1
        for p in range(m.start(), min(k + 1, len(text))):
            covered[p] = True
    return covered


def fix_manual_space(lines):
    """Remove a lone `#v(<n>pt)` line inside a fence (other content present),
    never inside #worksheet/#callout arguments."""
    states = fence_states(lines)
    edits = []
    for open_i, cs, ce, close_i in fence_blocks(lines, states):
        content = "\n".join(lines[cs:ce])
        if not content.strip():
            continue
        covered = callout_worksheet_covered(content)
        offsets, pos = [], 0
        for line in lines[cs:ce]:
            offsets.append(pos)
            pos += len(line) + 1
        others = [k for k, line in enumerate(lines[cs:ce]) if line.strip()]
        for k, line in enumerate(lines[cs:ce]):
            if not V_LINE.match(line.strip()):
                continue
            if len(others) <= 1:  # fence would become empty
                continue
            span = range(offsets[k], offsets[k] + len(line))
            if any(covered[p] for p in span if p < len(covered)):
                continue
            edits.append((cs + k, cs + k + 1, []))
    return edits


# ---------------------------------------------------------------- fixer 3: above: 0pt block

ABOVE0 = re.compile(r"#block\(above:\s*0pt[^)]*\)\[")


def fix_above0(lines):
    """Unwrap `#block(above: 0pt ...)[ BODY ]` -> BODY (bracket-balanced)."""
    states = fence_states(lines)
    edits = []
    for open_i, cs, ce, close_i in fence_blocks(lines, states):
        content = "\n".join(lines[cs:ce])
        changed = False
        while True:
            m = ABOVE0.search(content)
            if not m:
                break
            changed = True
            k, bd = m.end(), 1  # m.end() is just past the opening '['
            while k < len(content) and bd > 0:
                c = content[k]
                if c == "\\":
                    k += 2
                    continue
                if c == "[":
                    bd += 1
                elif c == "]":
                    bd -= 1
                    if bd == 0:
                        break
                k += 1
            body = content[m.end():k].strip("\n")
            content = content[:m.start()] + body + content[k + 1:]
        if not changed:
            continue  # never emit an edit that doesn't change a matched pattern
        new = content.split("\n")
        if new != lines[cs:ce]:
            edits.append((cs, ce, new))
    return edits


# ---------------------------------------------------------------- fixer 3b: manuscript par overrides

PAR_OVERRIDE = re.compile(r"#par\(\s*(?:leading|spacing):\s*[^)]*\)\[")
SET_PAR = re.compile(r"^\s*#set\s+par\(.*\)\s*$")


def is_component_fence(lines, cs, ce):
    """Fence defines a component (#let …) or is a box call — never edit those."""
    for k in range(cs, ce):
        s = lines[k].strip()
        if not s:
            continue
        return s.startswith("#let ") or any(s.startswith(n) for n in BOX_NAMES)
    return False


def fix_par_override(lines):
    """Inside non-component fences: unwrap `#par(leading: …)[ BODY ]` -> BODY
    (bracket-balanced, BODY byte-identical) and delete standalone `#set par(...)` lines."""
    states = fence_states(lines)
    edits = []
    for open_i, cs, ce, close_i in fence_blocks(lines, states):
        if is_component_fence(lines, cs, ce):
            continue
        content = "\n".join(lines[cs:ce])
        changed = False
        while True:
            m = PAR_OVERRIDE.search(content)
            if not m:
                break
            k, bd = m.end(), 1  # m.end() is just past the opening '['
            while k < len(content) and bd > 0:
                c = content[k]
                if c == "\\":
                    k += 2
                    continue
                if c == "[":
                    bd += 1
                elif c == "]":
                    bd -= 1
                    if bd == 0:
                        break
                k += 1
            if bd != 0:
                break  # unbalanced; leave untouched (gate will flag it)
            content = content[:m.start()] + content[m.end():k] + content[k + 1:]
            changed = True
        # delete standalone #set par(...) lines (balanced on the line)
        kept = []
        for line in content.split("\n"):
            if SET_PAR.match(line):
                changed = True
                continue
            kept.append(line)
        if changed:
            edits.append((cs, ce, kept))
    return edits


# ---------------------------------------------------------------- fixer 4: indent after box

def is_box_fence(lines, states, block):
    open_i, cs, ce, close_i = block
    for k in range(cs, ce):
        if lines[k].strip():
            return any(lines[k].strip().startswith(n) for n in BOX_NAMES + ("#list(", "#enum(", "#dropcap("))
    return False


def fix_body_indent(lines):
    """First paragraph after a box fence gets a #h(14pt) first-line indent:
    markdown prose gets the backticked inline form; in-fence prose gets plain."""
    states = fence_states(lines)
    edits = []
    n = len(lines)
    for block in fence_blocks(lines, states):
        if not is_box_fence(lines, states, block):
            continue
        close_i = block[3]
        if close_i is None:
            continue
        in_f = False
        j = close_i + 1
        while j < n:
            s = lines[j].strip()
            st = states[j]
            if st in ("open", "close"):
                in_f = st == "open"
                j += 1
                continue
            if not s:
                j += 1
                continue
            if not in_f and re.match(r"^#{1,6} ", s):  # heading: the next paragraph stays flush (Chicago)
                j = n
            break
        if j >= n:
            continue
        line = lines[j].lstrip()
        if in_f:
            if line.startswith("#h(") or NO_PREFIX.match(line) or re.match(r"^#[A-Za-z_]\w*[\(\[]", line):
                continue  # any component call (#takeaway[...], #orn, ...) is not a paragraph
            edits.append((j, j + 1, ["#h(14pt)" + line]))
        else:
            if line.startswith("#h(") or line.startswith("`#h("):
                continue
            edits.append((j, j + 1, ["`#h(14pt)`{=typst}" + line]))
    return edits


# ---------------------------------------------------------------- fixer 5: double space

def fix_double_space(lines):
    """Collapse 2+ spaces between non-space chars on prose lines outside fences."""
    states = fence_states(lines)
    edits = []
    for i, line in enumerate(lines):
        if inside(states, i) or states[i] in ("open", "close"):
            continue
        new = re.sub(r"(?<=\S)  +(?=\S)", " ", line)
        if new != line:
            edits.append((i, i + 1, [new]))
    return edits


# ---------------------------------------------------------------- fixer 5b: highlight unwrap

def fix_highlight(lines):
    """Unwrap `#highlight(fill: ...)[TEXT]` -> TEXT (bracket-balanced) across the
    whole chapter slice (review marks are unwrapped in place, prose or fence)."""
    text = "\n".join(lines)
    out = []
    i = 0
    changed = False
    while True:
        m = text.find("#highlight(", i)
        if m == -1:
            out.append(text[i:])
            break
        j, d = m + len("#highlight("), 1  # balance the highlight(...) arguments
        while j < len(text) and d > 0:
            c = text[j]
            if c == "(":
                d += 1
            elif c == ")":
                d -= 1
            j += 1
        if d != 0:  # unbalanced; leave untouched (gate will flag it)
            out.append(text[i:m + 1])
            i = m + 1
            continue
        k = j
        while k < len(text) and text[k].isspace():
            k += 1
        if k >= len(text) or text[k] != "[":
            out.append(text[i:j])
            i = j
            continue
        k2, bd = k, 0  # find the body's closing ']'
        while k2 < len(text):
            c = text[k2]
            if c == "\\":
                k2 += 2
                continue
            if c == "[":
                bd += 1
            elif c == "]":
                bd -= 1
                if bd == 0:
                    break
            k2 += 1
        if bd != 0:  # unbalanced; leave untouched (gate will flag it)
            out.append(text[i:k + 1])
            i = k + 1
            continue
        out.append(text[i:m])
        out.append(text[k + 1:k2])
        i = k2 + 1
        changed = True
    if not changed:
        return []
    new = "".join(out).split("\n")
    if new == lines:
        return []
    return [(0, len(lines), new)]


FIXERS = {
    "SRC-HANDBUILT-LIST": fix_handbuilt_lists,
    "SRC-MANUAL-SPACE": fix_manual_space,
    "SRC-ABOVE0": fix_above0,
    "SRC-PAR-OVERRIDE": fix_par_override,
    "BODY-INDENT": fix_body_indent,
    "SRC-DOUBLE-SPACE": fix_double_space,
    "SRC-HIGHLIGHT": fix_highlight,
}


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(prog="layout_fixers.py")
    ap.add_argument("chapter", choices=CHAPTERS)
    ap.add_argument("--dry-run", dest="mode", action="store_const", const="dry")
    ap.add_argument("--apply", dest="mode", action="store_const", const="apply")
    ap.add_argument("--manuscript", default=str(MS))
    ap.add_argument("--no-jev", dest="use_jev", action="store_false",
                    help="skip the Jev prose-hunk gate (fallback: today's behaviour)")
    ap.set_defaults(mode="dry", use_jev=True)
    args = ap.parse_args()

    ms = Path(args.manuscript)
    original = ms.read_text(encoding="utf-8").splitlines(keepends=False)
    start, end = find_slice(original, args.chapter)
    lines = original[start:end]
    counts, notes = {}, []
    for fid in FIX_IDS:
        edits = FIXERS[fid](lines)
        if edits:
            edits = gate_prose_hunks(lines, edits, notes, args.use_jev)
        counts[fid] = len(edits)
        for s, e, repl in edits:
            notes.append(f"{fid}: lines {start + s + 1}-" +
                         (f"{start + e}" if e > s + 1 else f"{start + s + 1}") +
                         (f" -> {repl[0][:60]!r}" if repl else " -> removed"))
        if edits:
            lines = apply_edits(lines, edits)
    result = original[:start] + lines + original[end:]

    if notes:
        print("Fixer report:")
        for n in notes:
            print(f"  - {n}")
    else:
        print("Fixer report: no changes")
    print("Counts: " + ", ".join(f"{fid}={counts[fid]}" for fid in FIX_IDS))

    if args.mode == "apply":
        REVISIONS.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
        backup = REVISIONS / f"manuscript_before_fix_{args.chapter}_{stamp}.md"
        backup.write_text("\n".join(original) + ("\n" if original else ""),
                          encoding="utf-8")
        ms.write_text("\n".join(result) + ("\n" if result else ""), encoding="utf-8")
        print(f"backup: {backup}")
        print(f"applied: {ms}")
    else:
        diff = difflib.unified_diff(original, result, fromfile=str(ms),
                                    tofile=str(ms) + " (fixed)", lineterm="")
        print("\n".join(diff))
    return 0


if __name__ == "__main__":
    sys.exit(main())
