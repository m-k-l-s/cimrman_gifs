"""Compatibility entry point; use `uv run python scripts/catalog.py build` instead."""

import sys

from scripts.catalog import main

if __name__ == "__main__":
    raise SystemExit(main(["build", *sys.argv[1:]]))
