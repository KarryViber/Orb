#!/usr/bin/env python3
"""Resolve channel name -> id via config.json.

Usage: channels-resolve.py <name> [--profile karry]
"""

import argparse
import json
import sys
from pathlib import Path


CONFIG = Path(__file__).resolve().parents[2] / "config.json"


def resolve(name: str, profile: str = "karry") -> str | None:
    with CONFIG.open() as f:
        cfg = json.load(f)
    channels = cfg.get("profiles", {}).get(profile, {}).get("channels", {})
    return channels.get(name)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("--profile", default="karry")
    args = ap.parse_args()
    cid = resolve(args.name, args.profile)
    if not cid:
        print(f"❌ unknown channel: {args.name}", file=sys.stderr)
        sys.exit(2)
    print(cid)


if __name__ == "__main__":
    main()
