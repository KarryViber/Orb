#!/usr/bin/env python3
"""Record auto-recalled Claude Code skills into memory-usage.db.

stdin JSON:
  {
    "db_path": "/path/to/orb/profiles/<profile>/data/memory-usage.db",
    "skills": ["dm-routing", ".../SKILL.md"],
    "ts": "2026-05-02T00:00:00Z",
    "thread_id": "...",
    "turn_id": "..."
  }
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

MEMORY_USAGE_DIR = Path(__file__).resolve().parent / "memory-usage"
sys.path.insert(0, str(MEMORY_USAGE_DIR))

from common import ensure_db  # noqa: E402


FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def utc_now() -> str:
  return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_payload() -> dict:
  raw = sys.stdin.read()
  if not raw.strip():
    return {}
  return json.loads(raw)


def frontmatter_name(skill_md: Path) -> str | None:
  try:
    text = skill_md.read_text(encoding="utf-8", errors="ignore")
  except OSError:
    return None
  match = FRONTMATTER_RE.match(text)
  if not match:
    return None
  for line in match.group(1).splitlines():
    if ":" not in line:
      continue
    key, _, value = line.partition(":")
    if key.strip() == "name":
      name = value.strip().strip("\"'")
      return name or None
  return None


def normalize_skill(value: object) -> str | None:
  raw = str(value or "").strip()
  if not raw:
    return None
  path = Path(raw).expanduser()
  if path.name == "SKILL.md":
    name = frontmatter_name(path)
    return name or path.parent.name
  return raw


def unique_skills(values: object) -> list[str]:
  if not isinstance(values, list):
    return []
  out: list[str] = []
  seen: set[str] = set()
  for value in values:
    name = normalize_skill(value)
    if not name or name.startswith("_"):
      continue
    if name in seen:
      continue
    seen.add(name)
    out.append(name)
  return out


def main() -> int:
  payload = read_payload()
  db_path = payload.get("db_path")
  if not db_path:
    raise SystemExit("db_path required")

  skills = unique_skills(payload.get("skills"))
  ts = payload.get("ts") or utc_now()
  thread_id = payload.get("thread_id")
  turn_id = payload.get("turn_id")

  conn = ensure_db(str(db_path))
  with conn:
    for name in skills:
      conn.execute(
        """
        INSERT INTO usage_log(thread_id, turn_id, ts, item_kind, item_id, evidence)
        VALUES (?, ?, ?, 'skill', ?, 'auto_recall')
        """,
        (thread_id, turn_id, ts, name),
      )
      conn.execute(
        """
        INSERT INTO item_state(item_kind, item_id, status, injection_count, use_count, last_injected_at, last_used_at)
        VALUES ('skill', ?, 'active', 0, 1, NULL, ?)
        ON CONFLICT(item_kind, item_id) DO UPDATE SET
          use_count = use_count + 1,
          last_used_at = excluded.last_used_at
        """,
        (name, ts),
      )
  print(f"recorded {len(skills)} skill auto-recall item(s)")
  return 0


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  except Exception as exc:
    print(f"skill-usage-tracker failed: {exc}", file=sys.stderr)
    raise
