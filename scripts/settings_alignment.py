#!/usr/bin/env python3
"""Settings alignment gate (A). Standard library only: no installs, so CI needs no new dependency.

Checks that every binding in payments/src/settings_bindings.json (values only, exported from the private
spec files) matches the numeric default of the same leaf key in payments/src/settings_registry.ts.

Trust model (lint-ci.yml, pull_request_target): this script comes from the BASE branch. The PR head is checked
out for reading only, and this script only reads the two files as text. Nothing from the PR is executed.

Usage: python3 -I scripts/settings_alignment.py --bindings <settings_bindings.json> --registry <settings_registry.ts>
Exit: 0 aligned, 1 drift or malformed input.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def registry_default(text: str, leaf: str) -> float:
    pattern = re.compile(rf"^\s*{re.escape(leaf)}:\s*(-?\d+(?:\.\d+)?),\s*(?://.*)?$", re.MULTILINE)
    hits = pattern.findall(text)
    if len(hits) != 1:
        raise ValueError(f"{leaf}: expected exactly 1 numeric default in the registry, found {len(hits)}")
    return float(hits[0])


def check(bindings_path: Path, registry_path: Path) -> tuple[list[str], int]:
    errors: list[str] = []
    data = json.loads(bindings_path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        return ["bindings file must be a non-empty list"], 0
    text = registry_path.read_text(encoding="utf-8")
    seen: set[str] = set()
    for item in data:
        key = item.get("key") if isinstance(item, dict) else None
        value = item.get("value") if isinstance(item, dict) else None
        if not isinstance(key, str) or not key or isinstance(value, bool) or not isinstance(value, (int, float)):
            errors.append(f"malformed binding: {item!r}")
            continue
        if key in seen:
            errors.append(f"{key}: duplicated")
            continue
        seen.add(key)
        try:
            actual = registry_default(text, key.split(".")[-1])
        except ValueError as exc:
            errors.append(f"{key}: {exc}")
            continue
        if float(value) != actual:
            errors.append(f"{key}: bindings={value:g} registry={actual:g}")
    return errors, len(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--registry", type=Path, required=True)
    args = parser.parse_args()
    errors, count = check(args.bindings, args.registry)
    if errors:
        for error in errors:
            print(f"DRIFT: {error}", file=sys.stderr)
        print(f"FAIL: {len(errors)} settings binding(s) out of line", file=sys.stderr)
        return 1
    print(f"OK: {count} settings binding(s) match the registry")
    return 0


if __name__ == "__main__":
    sys.exit(main())
