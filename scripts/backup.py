#!/usr/bin/env python3
"""Backup a file into <QA>/revisions/ before any destructive rewrite (Jev plan, T33-J1).

    from backup import backup
    dest = backup(path, tag)   # -> QA/revisions/<name>_<YYYY-MM-DD_HHMMSS>_<tag><ext>

CLI: python3 scripts/backup.py <file> <tag>   (prints the backup path)
"""
import datetime
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from book_config import QA  # noqa: E402


def backup(path, tag):
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"cannot back up missing file: {p}")
    dest = QA / "revisions" / f"{p.stem}_{datetime.datetime.now():%Y-%m-%d_%H%M%S}_{tag}{p.suffix}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, dest)
    return dest


if __name__ == "__main__":
    if len(sys.argv) != 3 or "--help" in sys.argv:
        print(__doc__)
        sys.exit(0 if "--help" in sys.argv else 2)
    print(backup(sys.argv[1], sys.argv[2]))
