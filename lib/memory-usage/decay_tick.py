#!/usr/bin/env python3
import argparse
import os
import re
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import ensure_db


FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def iso_now():
  return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_ts(value):
  if not value:
    return None
  try:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
  except ValueError:
    return None


def set_frontmatter_flag(path, key, value):
  p = Path(path)
  if not p.exists() or not p.is_file():
    return False
  text = p.read_text(encoding="utf-8")
  rendered = f"{key}: {'true' if value is True else value}"
  match = FRONTMATTER_RE.match(text)
  if match:
    fm = match.group(1).splitlines()
    replaced = False
    out = []
    for line in fm:
      if line.startswith(f"{key}:"):
        out.append(rendered)
        replaced = True
      else:
        out.append(line)
    if not replaced:
      out.append(rendered)
    new_text = "---\n" + "\n".join(out) + "\n---\n" + text[match.end():]
  else:
    new_text = f"---\n{rendered}\n---\n{text}"
  if new_text != text:
    p.write_text(new_text, encoding="utf-8")
    return True
  return False


def archive_path(item_id):
  p = Path(item_id)
  if not p.exists() or not p.is_file():
    return None
  archive_dir = p.parent / ".archive" / datetime.now().strftime("%Y-%m-%d")
  archive_dir.mkdir(parents=True, exist_ok=True)
  return archive_dir / p.name


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--data-dir", required=True)
  parser.add_argument("--archive", action="store_true")
  args = parser.parse_args()

  db_path = os.path.join(args.data_dir, "memory-usage.db")
  conn = ensure_db(db_path)
  now = datetime.now(timezone.utc)
  since_30 = (now - timedelta(days=30)).isoformat().replace("+00:00", "Z")
  archive_before = now - timedelta(weeks=12)
  summary = {"hot": 0, "warm": 0, "cold": 0, "archived": 0, "promoted": 0}

  rows = conn.execute(
    """
    SELECT item_kind, item_id,
      SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS injections_30,
      (SELECT COUNT(*) FROM usage_log u WHERE u.item_kind = i.item_kind AND u.item_id = i.item_id AND u.ts >= ?) AS uses_30,
      MAX(ts) AS last_injected_at
    FROM injection_log i
    GROUP BY item_kind, item_id
    """,
    (since_30, since_30),
  ).fetchall()

  with conn:
    for kind, item_id, injections_30, uses_30, last_injected_at in rows:
      injections_30 = injections_30 or 0
      uses_30 = uses_30 or 0
      total_injections, total_uses, last_used_at, previous = conn.execute(
        "SELECT injection_count, use_count, last_used_at, status FROM item_state WHERE item_kind=? AND item_id=?",
        (kind, item_id),
      ).fetchone() or (0, 0, None, None)

      if total_injections >= 6 and total_uses == 0:
        status = "cold"
      elif injections_30 and uses_30 / injections_30 >= 0.3:
        status = "hot"
      elif total_uses > 0:
        status = "warm"
      else:
        status = previous or "warm"

      last_used_dt = parse_ts(last_used_at)
      if args.archive and previous == "cold" and (not last_used_dt or last_used_dt < archive_before):
        dst = archive_path(item_id)
        if dst:
          shutil.move(item_id, dst)
          item_id = str(dst)
        status = "archived"

      conn.execute(
        """
        UPDATE item_state
        SET status=?, last_injected_at=COALESCE(?, last_injected_at)
        WHERE item_kind=? AND item_id=?
        """,
        (status, last_injected_at, kind, item_id),
      )
      summary[status] = summary.get(status, 0) + 1
      if status == "hot" and kind in {"lesson", "skill"} and set_frontmatter_flag(item_id, "recommend_promote", True):
        summary["promoted"] += 1

  print(summary)


if __name__ == "__main__":
  main()
