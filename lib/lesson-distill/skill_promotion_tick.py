#!/usr/bin/env python3
import argparse
import os
import re
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path


FM_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def update_frontmatter(path, updates):
  text = path.read_text(encoding="utf-8")
  match = FM_RE.match(text)
  fm = {}
  body = text
  if match:
    body = text[match.end():]
    for line in match.group(1).splitlines():
      if ":" in line:
        k, v = line.split(":", 1)
        fm[k.strip()] = v.strip()
  fm.update(updates)
  rendered = "---\n" + "\n".join(f"{k}: {v}" for k, v in fm.items()) + "\n---\n"
  path.write_text(rendered + body, encoding="utf-8")


def use_count(conn, skill_md):
  row = conn.execute(
    "SELECT use_count FROM item_state WHERE item_kind='skill' AND item_id=?",
    (str(skill_md),),
  ).fetchone()
  return int(row[0]) if row else 0


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--workspace-dir", required=True)
  parser.add_argument("--data-dir", required=True)
  args = parser.parse_args()

  skills_dir = Path(args.workspace_dir) / ".claude" / "skills"
  drafts_dir = skills_dir / "_drafts"
  archive_dir = skills_dir / "_archive"
  db_path = Path(args.data_dir) / "memory-usage.db"
  if not drafts_dir.exists():
    print("drafts=0 promoted=0 archived=0")
    return
  conn = sqlite3.connect(db_path) if db_path.exists() else sqlite3.connect(":memory:")
  promoted = 0
  archived = 0
  now = datetime.now(timezone.utc)
  archive_dir.mkdir(parents=True, exist_ok=True)

  for draft in sorted(item for item in drafts_dir.iterdir() if item.is_dir()):
    skill_md = draft / "SKILL.md"
    if not skill_md.exists():
      continue
    count = use_count(conn, skill_md)
    age_weeks = (now - datetime.fromtimestamp(skill_md.stat().st_mtime, timezone.utc)) / timedelta(weeks=1)
    if count >= 3:
      target = skills_dir / draft.name
      if target.exists():
        target = skills_dir / f"{draft.name}-{now.strftime('%Y%m%d%H%M%S')}"
      shutil.move(str(draft), str(target))
      update_frontmatter(target / "SKILL.md", {"stage": "production", "promoted_at": now.isoformat().replace("+00:00", "Z")})
      promoted += 1
    elif age_weeks >= 12 and count == 0:
      target = archive_dir / draft.name
      if target.exists():
        target = archive_dir / f"{draft.name}-{now.strftime('%Y%m%d%H%M%S')}"
      shutil.move(str(draft), str(target))
      archived += 1
  print(f"drafts={len(list(drafts_dir.glob('*')))} promoted={promoted} archived={archived}")


if __name__ == "__main__":
  main()
