#!/usr/bin/env python3
"""
scripts/quality_dashboard.py
Generates a self-contained HTML quality dashboard over time.
Python 3 stdlib only; output one self-contained HTML file (inline CSS + inline SVG; no external JS/CSS/fonts).

Inputs:
- data/intel/duane_book/qa/literary_runs/2026*.json (skip patch_*)
- data/intel/duane_book/qa/chapter_briefs/ch*_regrade_summary.md
- data/intel/duane_book/qa/qa_report_FULL.md

Output:
- data/intel/duane_book/qa/dashboard.html
"""

import os
import sys
import glob
import json
import re
import html
import statistics
from pathlib import Path

CHAPTER_NAMES = [
    "One", "Two", "Three", "Four", "Five",
    "Six", "Seven", "Eight", "Nine", "Ten"
]

CHAPTER_NUM_TO_NAME = {
    1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five",
    6: "Six", 7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten"
}

CHAPTER_NAME_TO_NUM = {v: k for k, v in CHAPTER_NUM_TO_NAME.items()}

GRADE_SCALE_MAP = {
    "A+": 4.33, "A": 4.0, "A-": 3.67,
    "B+": 3.33, "B": 3.0, "B-": 2.67,
    "C+": 2.33, "C": 2.0, "C-": 1.67,
    "D": 1.0, "F": 0.0
}

SCALE_NAMES = ["F", "D", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"]

def grade_to_numeric(g):
    if not g:
        return 0.0
    return GRADE_SCALE_MAP.get(g, 0.0)

def numeric_to_grade(val):
    best_grade = "F"
    min_diff = 999.0
    for g, num in GRADE_SCALE_MAP.items():
        diff = abs(val - num)
        if diff < min_diff:
            min_diff = diff
            best_grade = g
    return best_grade

def get_grade_color_class(grade):
    if not grade:
        return "grade-none"
    g = grade.strip()
    if g.startswith("A"):
        return "grade-a"
    elif g.startswith("B+"):
        return "grade-b-plus"
    elif g.startswith("B"):
        return "grade-b"
    elif g.startswith("C+"):
        return "grade-c-plus"
    elif g.startswith("C"):
        return "grade-c"
    elif g.startswith("D"):
        return "grade-d"
    else:
        return "grade-f"

def get_engagement_color_class(score):
    if score is None:
        return "eng-none"
    s = int(score)
    if s >= 5:
        return "eng-5"
    elif s == 4:
        return "eng-4"
    elif s == 3:
        return "eng-3"
    elif s == 2:
        return "eng-2"
    else:
        return "eng-1"

def load_runs(base_dir):
    runs_dir = os.path.join(base_dir, "data/intel/duane_book/qa/literary_runs")
    run_files = sorted(glob.glob(os.path.join(runs_dir, "2026*.json")))
    runs = []
    for rf in run_files:
        filename = os.path.basename(rf)
        if "patch_" in filename:
            continue
        try:
            with open(rf, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"Warning: could not read {rf}: {e}", file=sys.stderr)
            continue
        
        ts_str = data.get("ts") or filename.replace(".json", "")
        ch_overalls = data.get("chapter_overall", {})
        
        # Calculate book overall grade:
        # 1. Median numeric GPA (A=4, +/- 0.33)
        # 2. Mean numeric GPA
        # 3. Median letter grade
        gpas = [grade_to_numeric(ch_overalls[ch]) for ch in CHAPTER_NAMES if ch in ch_overalls]
        if gpas:
            med_gpa = statistics.median(gpas)
            mean_gpa = statistics.mean(gpas)
            letter_grade = numeric_to_grade(med_gpa)
        else:
            med_gpa = 0.0
            mean_gpa = 0.0
            letter_grade = "N/A"

        runs.append({
            "filepath": rf,
            "filename": filename,
            "timestamp": ts_str,
            "chapter_overall": ch_overalls,
            "median_gpa": med_gpa,
            "mean_gpa": mean_gpa,
            "overall_grade": letter_grade,
            "raw": data.get("raw", {})
        })
    
    # Sort runs chronologically
    runs.sort(key=lambda r: r["timestamp"])
    return runs

def parse_regrades(base_dir):
    briefs_dir = os.path.join(base_dir, "data/intel/duane_book/qa/chapter_briefs")
    summary_files = sorted(glob.glob(os.path.join(briefs_dir, "ch*_regrade_summary.md")))
    regrades = {}

    for sf in summary_files:
        fn = os.path.basename(sf)
        m_ch = re.search(r"ch(\d+)_", fn)
        if not m_ch:
            continue
        ch_num = int(m_ch.group(1))
        
        with open(sf, "r", encoding="utf-8") as f:
            content = f.read()

        # Parse OVERALL line
        # e.g.: OVERALL B -> B+; min C+; votes new/old/tie [59, 8, 77]
        # or: OVERALL B+ -> A-; min B; diff +0.33; votes new/old/tie [62, 9, 73]
        m = re.search(
            r"OVERALL\s+([A-D][+-]?)\s*->\s*([A-D][+-]?);\s*min\s+[A-D][+-]?;(?:\s*diff\s*[-+0-9.]+;)?\s*votes\s+new/old/tie\s*\[(\d+),\s*(\d+),\s*(\d+)\]",
            content
        )
        if m:
            before, after, new_v, old_v, tie_v = m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5))
            regrades[ch_num] = {
                "chapter_num": ch_num,
                "chapter_name": CHAPTER_NUM_TO_NAME.get(ch_num, f"Chapter {ch_num}"),
                "before": before,
                "after": after,
                "votes_new": new_v,
                "votes_old": old_v,
                "votes_tie": tie_v,
                "source_file": fn
            }
        else:
            # Fallback regex if formatted slightly differently
            m_simple = re.search(r"OVERALL\s+([A-D][+-]?)\s*->\s*([A-D][+-]?)", content)
            m_votes = re.search(r"votes\s+new/old/tie\s*\[(\d+),\s*(\d+),\s*(\d+)\]", content)
            if m_simple and m_votes:
                regrades[ch_num] = {
                    "chapter_num": ch_num,
                    "chapter_name": CHAPTER_NUM_TO_NAME.get(ch_num, f"Chapter {ch_num}"),
                    "before": m_simple.group(1),
                    "after": m_simple.group(2),
                    "votes_new": int(m_votes.group(1)),
                    "votes_old": int(m_votes.group(2)),
                    "votes_tie": int(m_votes.group(3)),
                    "source_file": fn
                }

    # Also check if ch5_regrade.md has info if summary is absent
    if 5 not in regrades:
        ch5_path = os.path.join(briefs_dir, "ch5_regrade.md")
        if os.path.exists(ch5_path):
            with open(ch5_path, "r", encoding="utf-8") as f:
                c5 = f.read()
            m5 = re.search(r"\*\*Chapter overall:\s*([A-D][+-]?)\s*→\s*([A-D][+-]?)\*\*.*?NEW better\s*(\d+),\s*OLD better\s*(\d+),\s*tie\s*(\d+)", c5, re.DOTALL)
            if m5:
                regrades[5] = {
                    "chapter_num": 5,
                    "chapter_name": "Five",
                    "before": m5.group(1),
                    "after": m5.group(2),
                    "votes_new": int(m5.group(3)),
                    "votes_old": int(m5.group(4)),
                    "votes_tie": int(m5.group(5)),
                    "source_file": "ch5_regrade.md (v1)"
                }

    return regrades

def parse_qa_report(base_dir):
    report_path = os.path.join(base_dir, "data/intel/duane_book/qa/qa_report_FULL.md")
    if not os.path.exists(report_path):
        return {}
    
    with open(report_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Split by Chapter section
    sections = re.split(r"^##\s+", content, flags=re.M)
    ch_fails = {}
    word_to_num = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
        "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10
    }

    for sec in sections[1:]:
        lines = sec.splitlines()
        header = lines[0].strip()
        m = re.search(r"Chapter\s+([A-Za-z]+)", header, re.IGNORECASE)
        if not m:
            continue
        word = m.group(1).lower()
        if word not in word_to_num:
            continue
        ch_num = word_to_num[word]

        # Count fail rows: lines matching | FAIL ... |
        fail_rows = [line for line in lines if re.search(r"\|\s*FAIL(?:\s*\(.*?\))?\s*\|", line)]
        ch_fails[ch_num] = {
            "chapter_num": ch_num,
            "chapter_name": CHAPTER_NUM_TO_NAME[ch_num],
            "header": header,
            "fail_count": len(fail_rows),
            "fail_details": fail_rows
        }
    
    return ch_fails

def generate_svg_line_chart(runs_chronological):
    """
    Renders an inline SVG showing overall book grade per run over time.
    Grade scale A=4.0 ... C=2.0 (with +/- = +-0.33).
    """
    if not runs_chronological:
        return "<svg viewBox='0 0 400 150' class='chart-svg'><text x='20' y='80'>No run data</text></svg>"

    width = 540
    height = 200
    padding_left = 65
    padding_right = 45
    padding_top = 30
    padding_bottom = 45

    plot_w = width - padding_left - padding_right
    plot_h = height - padding_top - padding_bottom

    # Y scale: 2.0 (C) to 4.33 (A+)
    min_val = 2.0
    max_val = 4.33
    
    def val_to_y(v):
        clamped = max(min_val, min(max_val, v))
        ratio = (clamped - min_val) / (max_val - min_val)
        return padding_top + (1.0 - ratio) * plot_h

    # X coordinates
    n_points = len(runs_chronological)
    if n_points == 1:
        x_coords = [padding_left + plot_w / 2]
    else:
        x_coords = [padding_left + i * (plot_w / (n_points - 1)) for i in range(n_points)]

    points = []
    for i, r in enumerate(runs_chronological):
        # We can plot mean_gpa or median_gpa. mean_gpa gives smooth sensitivity, median gives discrete grade.
        y = val_to_y(r["mean_gpa"])
        points.append((x_coords[i], y, r))

    svg_parts = []
    svg_parts.append(f"<svg viewBox='0 0 {width} {height}' class='chart-svg' role='img' aria-label='Book overall grade trend'>")
    
    # Grid lines and Y axis labels
    grid_grades = [
        ("A+", 4.33), ("A", 4.0), ("A-", 3.67),
        ("B+", 3.33), ("B", 3.0), ("B-", 2.67),
        ("C+", 2.33), ("C", 2.0)
    ]
    for g_name, g_val in grid_grades:
        gy = val_to_y(g_val)
        svg_parts.append(f"<line x1='{padding_left}' y1='{gy:.1f}' x2='{width - padding_right}' y2='{gy:.1f}' class='chart-grid-line' />")
        svg_parts.append(f"<text x='{padding_left - 10}' y='{gy + 4:.1f}' text-anchor='end' class='chart-axis-label'>{g_name}</text>")

    # Connecting line path
    path_d = []
    for i, (px, py, _) in enumerate(points):
        cmd = "M" if i == 0 else "L"
        path_d.append(f"{cmd} {px:.1f} {py:.1f}")
    
    if len(points) > 1:
        # Area fill under the line
        area_d = list(path_d)
        area_d.append(f"L {points[-1][0]:.1f} {padding_top + plot_h:.1f}")
        area_d.append(f"L {points[0][0]:.1f} {padding_top + plot_h:.1f}")
        area_d.append("Z")
        svg_parts.append(f"<path d='{' '.join(area_d)}' class='chart-area-fill' />")
        svg_parts.append(f"<path d='{' '.join(path_d)}' class='chart-trend-line' />")

    # Data points and labels
    for px, py, r in points:
        ts_short = r["timestamp"].split("T")[-1][:5]
        g_label = f"{r['overall_grade']} ({r['mean_gpa']:.2f})"
        svg_parts.append(f"<circle cx='{px:.1f}' cy='{py:.1f}' r='5' class='chart-point' />")
        svg_parts.append(f"<text x='{px:.1f}' y='{py - 10:.1f}' text-anchor='middle' class='chart-point-label'>{g_label}</text>")
        svg_parts.append(f"<text x='{px:.1f}' y='{height - padding_bottom + 18:.1f}' text-anchor='middle' class='chart-run-label'>{ts_short}</text>")

    svg_parts.append("</svg>")
    return "\n".join(svg_parts)

def build_dashboard_html(base_dir):
    runs_chronological = load_runs(base_dir)
    runs_newest_first = list(reversed(runs_chronological))
    regrades = parse_regrades(base_dir)
    qa_fails = parse_qa_report(base_dir)

    newest_run = runs_newest_first[0] if runs_newest_first else None

    # Inline CSS with colorblind-safe sequential palette and prefers-color-scheme
    css = """
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-alt: #f1f5f9;
      --border: #cbd5e1;
      --text: #0f172a;
      --text-muted: #64748b;
      
      /* Colorblind-safe Viridis-inspired / Muted sequential scale */
      --c-grade-a: #107569;      /* deep teal */
      --c-grade-a-bg: #ccfbf1;   /* light teal */
      --c-grade-bplus: #0284c7;  /* blue */
      --c-grade-bplus-bg: #e0f2fe;
      --c-grade-b: #3b82f6;      /* cornflower blue */
      --c-grade-b-bg: #eff6ff;
      --c-grade-cplus: #d97706;  /* amber */
      --c-grade-cplus-bg: #fef3c7;
      --c-grade-c: #ea580c;      /* orange */
      --c-grade-c-bg: #ffedd5;
      --c-grade-d: #dc2626;      /* red */
      --c-grade-d-bg: #fee2e2;
      --c-grade-none: #94a3b8;
      --c-grade-none-bg: #f1f5f9;

      /* Engagement sequential palette */
      --c-eng-5: #047857;
      --c-eng-5-bg: #d1fae5;
      --c-eng-4: #0284c7;
      --c-eng-4-bg: #e0f2fe;
      --c-eng-3: #f59e0b;
      --c-eng-3-bg: #fef3c7;
      --c-eng-2: #ea580c;
      --c-eng-2-bg: #ffedd5;
      --c-eng-1: #dc2626;
      --c-eng-1-bg: #fee2e2;

      /* Chart */
      --chart-line: #0284c7;
      --chart-area: rgba(2, 132, 199, 0.12);
      --chart-point: #0369a1;
      --chart-grid: #e2e8f0;
      --chart-text: #475569;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0f19;
        --surface: #1e293b;
        --surface-alt: #0f172a;
        --border: #334155;
        --text: #f8fafc;
        --text-muted: #94a3b8;

        /* Keep sequential colors crisp and high contrast in dark mode */
        --c-grade-a: #5eead4;
        --c-grade-a-bg: #134e4a;
        --c-grade-bplus: #7dd3fc;
        --c-grade-bplus-bg: #0c4a6e;
        --c-grade-b: #93c5fd;
        --c-grade-b-bg: #1e3a8a;
        --c-grade-cplus: #fcd34d;
        --c-grade-cplus-bg: #78350f;
        --c-grade-c: #fdba74;
        --c-grade-c-bg: #7c2d12;
        --c-grade-d: #fca5a5;
        --c-grade-d-bg: #7f1d1d;
        --c-grade-none: #94a3b8;
        --c-grade-none-bg: #334155;

        --c-eng-5: #6ee7b7;
        --c-eng-5-bg: #064e3b;
        --c-eng-4: #7dd3fc;
        --c-eng-4-bg: #0c4a6e;
        --c-eng-3: #fcd34d;
        --c-eng-3-bg: #78350f;
        --c-eng-2: #fdba74;
        --c-eng-2-bg: #7c2d12;
        --c-eng-1: #fca5a5;
        --c-eng-1-bg: #7f1d1d;

        --chart-line: #38bdf8;
        --chart-area: rgba(56, 189, 248, 0.18);
        --chart-point: #7dd3fc;
        --chart-grid: #334155;
        --chart-text: #94a3b8;
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      padding: 16px;
      max-width: 960px;
      margin: 0 auto;
      overflow-x: hidden;
    }

    header {
      margin-bottom: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 6px;
      color: var(--text);
    }

    .subtitle {
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }

    .section-title {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .section-desc {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    /* Scroll containers for mobile readability (<= 390px) */
    .table-container {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-alt);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      text-align: left;
      white-space: nowrap;
    }

    th, td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }

    th {
      background: var(--surface);
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    tr:last-child td {
      border-bottom: none;
    }

    /* Grade badge cells */
    .cell-grade {
      text-align: center;
      font-weight: 700;
      font-size: 0.85rem;
      border-radius: 4px;
      padding: 4px 8px;
      display: inline-block;
      min-width: 38px;
    }

    .grade-a { color: var(--c-grade-a); background: var(--c-grade-a-bg); }
    .grade-b-plus { color: var(--c-grade-bplus); background: var(--c-grade-bplus-bg); }
    .grade-b { color: var(--c-grade-b); background: var(--c-grade-b-bg); }
    .grade-c-plus { color: var(--c-grade-cplus); background: var(--c-grade-cplus-bg); }
    .grade-c { color: var(--c-grade-c); background: var(--c-grade-c-bg); }
    .grade-d { color: var(--c-grade-d); background: var(--c-grade-d-bg); }
    .grade-f { color: var(--c-grade-d); background: var(--c-grade-d-bg); }
    .grade-none { color: var(--c-grade-none); background: var(--c-grade-none-bg); }

    /* Engagement badge cells */
    .cell-eng {
      text-align: center;
      font-weight: 700;
      font-size: 0.85rem;
      border-radius: 4px;
      padding: 4px 10px;
      display: inline-block;
      min-width: 32px;
    }
    .eng-5 { color: var(--c-eng-5); background: var(--c-eng-5-bg); }
    .eng-4 { color: var(--c-eng-4); background: var(--c-eng-4-bg); }
    .eng-3 { color: var(--c-eng-3); background: var(--c-eng-3-bg); }
    .eng-2 { color: var(--c-eng-2); background: var(--c-eng-2-bg); }
    .eng-1 { color: var(--c-eng-1); background: var(--c-eng-1-bg); }
    .eng-none { color: var(--c-grade-none); background: var(--c-grade-none-bg); }

    /* SVG Chart styles */
    .chart-container {
      width: 100%;
      overflow-x: auto;
      margin: 12px 0;
    }

    .chart-svg {
      width: 100%;
      max-width: 540px;
      height: auto;
      display: block;
      margin: 0 auto;
    }

    .chart-grid-line {
      stroke: var(--chart-grid);
      stroke-width: 1;
      stroke-dasharray: 3 3;
    }

    .chart-axis-label {
      fill: var(--chart-text);
      font-size: 11px;
      font-weight: 500;
    }

    .chart-area-fill {
      fill: var(--chart-area);
    }

    .chart-trend-line {
      fill: none;
      stroke: var(--chart-line);
      stroke-width: 2.5;
      stroke-linejoin: round;
      stroke-linecap: round;
    }

    .chart-point {
      fill: var(--chart-point);
    }

    .chart-point-label {
      fill: var(--text);
      font-size: 11px;
      font-weight: 700;
    }

    .chart-run-label {
      fill: var(--chart-text);
      font-size: 10px;
      font-weight: 500;
    }

    /* Summary list / cards for quotes */
    .quotes-list {
      list-style: none;
      margin-top: 14px;
      display: grid;
      gap: 10px;
    }

    .quote-item {
      background: var(--surface-alt);
      border-left: 4px solid var(--c-eng-2);
      border-radius: 4px;
      padding: 10px 14px;
      font-size: 0.85rem;
    }

    .quote-meta {
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
      font-size: 0.8rem;
    }

    .quote-text {
      color: var(--text-muted);
      font-style: italic;
    }

    /* Gate badge */
    .badge-pass {
      background: var(--c-eng-5-bg);
      color: var(--c-eng-5);
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
    }

    .badge-fail {
      background: var(--c-grade-d-bg);
      color: var(--c-grade-d);
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
    }

    .vote-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: monospace;
      font-size: 0.85rem;
    }

    .vote-tag-new { color: var(--c-grade-a); font-weight: bold; }
    .vote-tag-old { color: var(--c-grade-d); font-weight: bold; }
    .vote-tag-tie { color: var(--text-muted); }

    /* Summary cards on top */
    .runs-meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }

    .run-card {
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
    }

    .run-card-label {
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
    }

    .run-card-val {
      font-size: 1.15rem;
      font-weight: 700;
      color: var(--text);
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    footer {
      text-align: center;
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 32px;
      padding: 16px 0;
    }
    """

    # Section 1: Header with SVG line chart
    svg_chart = generate_svg_line_chart(runs_chronological)
    latest_run_summary = ""
    if runs_newest_first:
        lr = runs_newest_first[0]
        latest_run_summary = f"""
        <div class="runs-meta-grid">
          <div class="run-card">
            <div class="run-card-label">Latest Run</div>
            <div class="run-card-val">{html.escape(lr['timestamp'][:16].replace('T', ' '))}</div>
          </div>
          <div class="run-card">
            <div class="run-card-label">Overall Grade</div>
            <div class="run-card-val">
              <span class="cell-grade {get_grade_color_class(lr['overall_grade'])}">{lr['overall_grade']}</span>
              <span style="font-size:0.9rem; font-weight:normal; color:var(--text-muted);">({lr['mean_gpa']:.2f} GPA)</span>
            </div>
          </div>
          <div class="run-card">
            <div class="run-card-label">Evaluated Runs</div>
            <div class="run-card-val">{len(runs_chronological)}</div>
          </div>
        </div>
        """

    # Section 2: Chapter x run grid of overall grades (newest run first)
    grid_rows = []
    for ch_name in CHAPTER_NAMES:
        ch_num = CHAPTER_NAME_TO_NUM[ch_name]
        tds = [f"<td><strong>Ch {ch_num} ({ch_name})</strong></td>"]
        for r in runs_newest_first:
            g = r["chapter_overall"].get(ch_name, "—")
            c_class = get_grade_color_class(g)
            tds.append(f"<td style='text-align:center;'><span class='cell-grade {c_class}'>{g}</span></td>")
        grid_rows.append(f"<tr>{''.join(tds)}</tr>")

    # Header row for Section 2
    grid_th = ["<th>Chapter</th>"]
    for r in runs_newest_first:
        ts_display = r["timestamp"].split("T")[-1][:5]
        grid_th.append(f"<th style='text-align:center;'>Run {ts_display}<br><span style='font-size:0.7rem; font-weight:normal;'>{r['overall_grade']}</span></th>")

    # Section 3: Reader heat map for newest run (persona x chapter engagement 1-5, stop quotes)
    reader_rows = []
    stop_quotes = []
    personas = ["pre-retiree", "retiree", "spouse"]
    
    if newest_run and "raw" in newest_run:
        for p in personas:
            key = f"reader|{p}"
            r_data = newest_run["raw"].get(key, {})
            ch_data = r_data.get("chapters", {})
            tds = [f"<td><strong>{p.capitalize()}</strong></td>"]
            for ch_name in CHAPTER_NAMES:
                ch_info = ch_data.get(ch_name, {})
                eng = ch_info.get("engagement")
                stop = ch_info.get("stop_at")
                if stop:
                    stop_quotes.append({
                        "persona": p,
                        "chapter": ch_name,
                        "quote": stop
                    })
                c_class = get_engagement_color_class(eng)
                eng_display = str(eng) if eng is not None else "—"
                tds.append(f"<td style='text-align:center;'><span class='cell-eng {c_class}'>{eng_display}</span></td>")
            reader_rows.append(f"<tr>{''.join(tds)}</tr>")

    reader_th = ["<th>Persona</th>"] + [f"<th style='text-align:center;'>Ch {CHAPTER_NAME_TO_NUM[c]}</th>" for c in CHAPTER_NAMES]

    # Quotes HTML
    quotes_html = ""
    if stop_quotes:
        items = []
        for q in stop_quotes:
            ch_num = CHAPTER_NAME_TO_NUM.get(q["chapter"], q["chapter"])
            items.append(f"""
            <li class="quote-item">
              <div class="quote-meta">{html.escape(q['persona'].capitalize())} &bull; Chapter {ch_num} ({html.escape(q['chapter'])})</div>
              <div class="quote-text">&ldquo;{html.escape(q['quote'])}&rdquo;</div>
            </li>
            """)
        quotes_html = f"<ul class=\"quotes-list\">{''.join(items)}</ul>"
    else:
        quotes_html = "<p style='color:var(--text-muted); font-size:0.85rem; margin-top:12px;'>No stop quotes recorded in the newest run.</p>"

    # Section 4: Latest re-grade per chapter (overall before -> after, votes new/old/tie)
    regrade_rows = []
    for ch_num in range(1, 11):
        ch_name = CHAPTER_NUM_TO_NAME[ch_num]
        rg = regrades.get(ch_num)
        if rg:
            before_class = get_grade_color_class(rg["before"])
            after_class = get_grade_color_class(rg["after"])
            before_span = f"<span class='cell-grade {before_class}'>{rg['before']}</span>"
            after_span = f"<span class='cell-grade {after_class}'>{rg['after']}</span>"
            votes_str = f"<div class='vote-bar'><span class='vote-tag-new'>+{rg['votes_new']}</span> / <span class='vote-tag-old'>-{rg['votes_old']}</span> / <span class='vote-tag-tie'>={rg['votes_tie']}</span></div>"
            regrade_rows.append(f"""
            <tr>
              <td><strong>Ch {ch_num}</strong> ({ch_name})</td>
              <td style='text-align:center;'>{before_span} &rarr; {after_span}</td>
              <td>{votes_str}</td>
            </tr>
            """)
        else:
            regrade_rows.append(f"""
            <tr>
              <td><strong>Ch {ch_num}</strong> ({ch_name})</td>
              <td style='text-align:center; color:var(--text-muted);'>—</td>
              <td style='color:var(--text-muted); font-size:0.8rem;'>Not regraded</td>
            </tr>
            """)

    # Section 5: Layout gate (count of FAIL rows from qa_report_FULL.md per chapter)
    layout_rows = []
    total_fails = 0
    for ch_num in range(1, 11):
        ch_name = CHAPTER_NUM_TO_NAME[ch_num]
        q_info = qa_fails.get(ch_num)
        fail_count = q_info["fail_count"] if q_info else 0
        total_fails += fail_count
        if fail_count == 0:
            badge = "<span class='badge-pass'>0 FAIL (PASS)</span>"
        else:
            badge = f"<span class='badge-fail'>{fail_count} FAIL</span>"
        
        detail_snippets = ""
        if q_info and q_info["fail_details"]:
            rule_names = []
            for row in q_info["fail_details"]:
                parts = [p.strip() for p in row.split("|")]
                if len(parts) > 1 and parts[1]:
                    rule_names.append(parts[1])
            if rule_names:
                detail_snippets = f"<span style='font-size:0.75rem; color:var(--text-muted); margin-left:8px;'>({', '.join(rule_names[:3])}{'...' if len(rule_names) > 3 else ''})</span>"

        layout_rows.append(f"""
        <tr>
          <td><strong>Ch {ch_num}</strong> ({ch_name})</td>
          <td>{badge}{detail_snippets}</td>
        </tr>
        """)

    html_doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quality Dashboard &mdash; Duane Book</title>
  <style>
{css}
  </style>
</head>
<body>

  <!-- Section 1: Header with SVG line chart of book overall grade per run -->
  <header>
    <h1>Book Quality Dashboard</h1>
    <p class="subtitle">Self-contained quality tracking across panel runs, reader engagement, remediations, and layout gate.</p>
    
    <div class="section-title">
      <span>Book Overall Grade Trend</span>
      <span style="font-size:0.85rem; font-weight:normal; color:var(--text-muted);">Scale: A=4.0 to C=2.0 (&plusmn;0.33)</span>
    </div>
    <div class="chart-container">
      {svg_chart}
    </div>
    {latest_run_summary}
  </header>

  <!-- Section 2: Chapter x run grid of overall grades -->
  <section class="section">
    <div class="section-title">
      <span>1. Chapter &times; Run Overall Grades</span>
      <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">Newest run first</span>
    </div>
    <p class="section-desc">Historical progression of overall letter grades across all chapters and literary panel runs.</p>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            {''.join(grid_th)}
          </tr>
        </thead>
        <tbody>
          {''.join(grid_rows)}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Section 3: Reader heat map for the newest run -->
  <section class="section">
    <div class="section-title">
      <span>2. Reader Engagement Heatmap (Latest Run)</span>
      <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">Engagement Scale 1 (Low) to 5 (High)</span>
    </div>
    <p class="section-desc">Persona engagement scores across each chapter from the most recent evaluation run ({html.escape(newest_run['timestamp'][:16].replace('T', ' ') if newest_run else 'N/A')}).</p>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            {''.join(reader_th)}
          </tr>
        </thead>
        <tbody>
          {''.join(reader_rows)}
        </tbody>
      </table>
    </div>

    <div style="margin-top: 20px;">
      <h3 style="font-size:0.95rem; font-weight:600; margin-bottom:4px;">Reader Stop Quotes</h3>
      <p style="font-size:0.8rem; color:var(--text-muted);">Points in the manuscript where reader personas stopped or reported loss of immersion:</p>
      {quotes_html}
    </div>
  </section>

  <!-- Section 4: Latest re-grade per chapter -->
  <section class="section">
    <div class="section-title">
      <span>3. Chapter Remediations &amp; Re-grade Verdicts</span>
      <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">Before &rarr; After &bull; Votes [New / Old / Tie]</span>
    </div>
    <p class="section-desc">Comparative pairwise regrade evaluations assessing before vs. after remediation rewrites.</p>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Chapter</th>
            <th style="text-align:center;">Grade Delta</th>
            <th>Votes (New / Old / Tie)</th>
          </tr>
        </thead>
        <tbody>
          {''.join(regrade_rows)}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Section 5: Layout gate per chapter -->
  <section class="section">
    <div class="section-title">
      <span>4. Layout Gate Status (qa_report_FULL.md)</span>
      <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">Total Open FAIL Rows: {total_fails}</span>
    </div>
    <p class="section-desc">Count of typographic and layout verification failures per chapter against ADR-0043 design rules.</p>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Chapter</th>
            <th>Gate Result &amp; Failure Count</th>
          </tr>
        </thead>
        <tbody>
          {''.join(layout_rows)}
        </tbody>
      </table>
    </div>
  </section>

  <footer>
    Quality Dashboard &bull; Generated autonomously &bull; Self-contained HTML/SVG
  </footer>

</body>
</html>
"""
    return html_doc

def main():
    repo_root = os.getcwd()
    output_path = os.path.join(repo_root, "data/intel/duane_book/qa/dashboard.html")
    
    print(f"Generating dashboard from repository root: {repo_root}")
    html_content = build_dashboard_html(repo_root)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html_content)

    file_size = os.path.getsize(output_path)
    print(f"Wrote {file_size} bytes to {output_path}")

    # Summary of section counts
    runs = load_runs(repo_root)
    regrades = parse_regrades(repo_root)
    qa_fails = parse_qa_report(repo_root)
    print(f"Section counts:")
    print(f"  1. Header/Runs: {len(runs)} runs")
    print(f"  2. Chapter x Run grid: 10 chapters x {len(runs)} runs")
    print(f"  3. Reader heatmap: 3 personas x 10 chapters (newest run: {runs[-1]['timestamp'] if runs else 'None'})")
    print(f"  4. Latest re-grade per chapter: {len(regrades)} chapters regraded")
    print(f"  5. Layout gate: {len(qa_fails)} chapters parsed, {sum(c['fail_count'] for c in qa_fails.values())} total fail rows")

if __name__ == "__main__":
    main()
