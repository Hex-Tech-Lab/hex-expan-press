#!/usr/bin/env python3
"""Load the literary-panel rubric from data files (<QA>/rubric/).

Layout:
  rubric/core.json                 {"anchors": "...", "dimensions": [{"id", "name", "definition", "anchors": {...}}]}
  rubric/modules/<id>.json         same shape as core.json
  rubric/profiles/<profile>.json   {"modules": ["<id>", ...], "personas": {...}, "thresholds": {...},
                                    "order": ["<dimension id or name>", ...]  # optional, overrides file order
                                    "anchors": "..."  # optional, overrides core anchors text
                                   }

load(profile) -> (DIMS, ANCHORS, PERSONAS, THRESHOLDS)
DIMS is a list of dimension-name strings (core first in file order, then each module in the
profile's module order; the profile's optional "order" list wins if present).
ANCHORS is the anchors paragraph string; PERSONAS a dict name -> description; THRESHOLDS a dict.
"""
import sys
import json
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA as QA_DIR  # noqa: E402

RUBRIC = QA_DIR / "rubric"
from book_config import CFG as _CFG, BOOK_ID as _BID  # noqa: E402
DEFAULT_PROFILE = _CFG.get("rubric_profile", _BID)


def _load_dimensions(path):
    d = json.loads(path.read_text())
    dims = d.get("dimensions")
    if not isinstance(dims, list) or not dims:
        raise ValueError(f"{path}: 'dimensions' must be a non-empty list")
    out = []
    for dim in dims:
        if not isinstance(dim, dict) or not dim.get("id") or not dim.get("name"):
            raise ValueError(f"{path}: every dimension needs 'id' and 'name'")
        out.append(dim)
    return out, d


def load(profile=DEFAULT_PROFILE):
    pdir = RUBRIC / "profiles" / f"{profile}.json"
    prof = json.loads(pdir.read_text())

    core, core_doc = _load_dimensions(RUBRIC / "core.json")
    dims = list(core)
    for mid in prof.get("modules", []):
        mod, _ = _load_dimensions(RUBRIC / "modules" / f"{mid}.json")
        dims.extend(mod)

    order = prof.get("order")
    if order:
        by_key = {}
        for d in dims:
            by_key.setdefault(d["id"], d)
            by_key.setdefault(d["name"], d)
        missing = [k for k in order if k not in by_key]
        if missing:
            raise ValueError(f"profile {profile}: 'order' references unknown dimensions: {missing}")
        seen, ordered = set(), []
        for k in order:
            d = by_key[k]
            if d["id"] not in seen:
                seen.add(d["id"])
                ordered.append(d)
        for d in dims:  # any dimension not listed keeps file order after the ordered ones
            if d["id"] not in seen:
                seen.add(d["id"])
                ordered.append(d)
        dims = ordered

    anchors = prof.get("anchors", core_doc.get("anchors"))
    if not isinstance(anchors, str) or not anchors.strip():
        raise ValueError(f"rubric: no 'anchors' text in profile {profile} or core.json")

    personas = prof.get("personas")
    if not isinstance(personas, dict) or not personas:
        raise ValueError(f"profile {profile}: 'personas' must be a non-empty object")

    return [d["name"] for d in dims], anchors, dict(personas), dict(prof.get("thresholds") or {})


def profile_path(profile=DEFAULT_PROFILE):
    return RUBRIC / "profiles" / f"{profile}.json"


def active_profile():
    """Profile to use, or None when the hard-coded constants should stay in effect."""
    env = os.environ.get("RUBRIC_PROFILE")
    if env:
        return env
    return DEFAULT_PROFILE if profile_path().exists() else None
