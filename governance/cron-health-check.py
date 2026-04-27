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
    print("memory_usage_db=missing")
    return
  conn = sqlite3.connect(db_path)
  counts = dict(conn.execute(
    "SELECT status, COUNT(*) FROM item_state GROUP BY status"
  ).fetchall())
  cold = counts.get("cold", 0)
  archived = counts.get("archived", 0)
  hot = counts.get("hot", 0)
  warm = counts.get("warm", 0)
  print(f"memory_usage_db=ok hot={hot} warm={warm} cold={cold} archived={archived}")
  if cold > 50:
    print(f"warning=cold_items_high count={cold}")


if __name__ == "__main__":
  main()
