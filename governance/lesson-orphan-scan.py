#!/usr/bin/env python3
import argparse
import os
import sqlite3


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--data-dir", default=os.path.expanduser("~/Orb/profiles/karry/data"))
  args = parser.parse_args()
  db_path = os.path.join(args.data_dir, "memory-usage.db")
  if not os.path.exists(db_path):
    print("memory-usage.db missing; no item_state data")
    return
  conn = sqlite3.connect(db_path)
  rows = conn.execute(
    """
    SELECT item_kind, item_id, status, injection_count, use_count, last_injected_at
    FROM item_state
    WHERE item_kind = 'lesson' AND status IN ('cold', 'archived')
    ORDER BY status, injection_count DESC, item_id
    """
  ).fetchall()
  for kind, item_id, status, injections, uses, last_injected in rows:
    print(f"{status}\t{injections}\t{uses}\t{last_injected or ''}\t{item_id}")


if __name__ == "__main__":
  main()
