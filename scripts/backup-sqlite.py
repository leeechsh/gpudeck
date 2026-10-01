#!/usr/bin/env python3
"""Consistent online backup of SQLite, including committed WAL contents."""
import argparse
import os
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
os.umask(0o077)
if not args.source.is_file() or args.destination.exists():
    raise SystemExit("Source must exist and destination must not exist")
source = sqlite3.connect(args.source.resolve().as_uri() + "?mode=ro", uri=True)
target = sqlite3.connect(args.destination)
try:
    source.backup(target)
    assert target.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
finally:
    target.close()
    source.close()
print(f"Verified SQLite backup: {args.destination}")
