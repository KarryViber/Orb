#!/usr/bin/env python3
import sys
from common import ensure_db, normalize_items, read_json_stdin, utc_now


def main():
  payload = read_json_stdin()
  db_path = payload.get("db_path")
  if not db_path:
    raise SystemExit("db_path required")

  ts = payload.get("ts") or utc_now()
  thread_id = payload.get("thread_id")
  turn_id = payload.get("turn_id")
  items = normalize_items(payload.get("items"))

  conn = ensure_db(db_path)
  with conn:
    for item in items:
      conn.execute(
        "INSERT INTO injection_log(thread_id, turn_id, ts, item_kind, item_id, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
        (thread_id, turn_id, ts, item["item_kind"], item["item_id"], item["content_hash"]),
      )
      conn.execute(
        """
        INSERT INTO item_state(item_kind, item_id, status, injection_count, use_count, last_injected_at, last_used_at)
        VALUES (?, ?, 'warm', 1, 0, ?, NULL)
        ON CONFLICT(item_kind, item_id) DO UPDATE SET
          injection_count = injection_count + 1,
          last_injected_at = excluded.last_injected_at
        """,
        (item["item_kind"], item["item_id"], ts),
      )
  print(f"recorded {len(items)} injection item(s)")


if __name__ == "__main__":
  try:
    main()
  except Exception as exc:
    print(f"record_injection failed: {exc}", file=sys.stderr)
    raise
