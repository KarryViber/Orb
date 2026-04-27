#!/usr/bin/env python3
import sys
from common import ensure_db, normalize_items, read_json_stdin, utc_now


VALID_EVIDENCE = {"tool_arg", "text_quote", "explicit_ref"}


def main():
  payload = read_json_stdin()
  db_path = payload.get("db_path")
  if not db_path:
    raise SystemExit("db_path required")

  ts = payload.get("ts") or utc_now()
  thread_id = payload.get("thread_id")
  turn_id = payload.get("turn_id")
  items = normalize_items(payload.get("items"))

  rows = []
  for item in items:
    evidence = item.get("evidence") or "explicit_ref"
    if evidence not in VALID_EVIDENCE:
      evidence = "explicit_ref"
    rows.append((item["item_kind"], item["item_id"], evidence))

  conn = ensure_db(db_path)
  with conn:
    for kind, item_id, evidence in rows:
      conn.execute(
        "INSERT INTO usage_log(thread_id, turn_id, ts, item_kind, item_id, evidence) VALUES (?, ?, ?, ?, ?, ?)",
        (thread_id, turn_id, ts, kind, item_id, evidence),
      )
      conn.execute(
        """
        INSERT INTO item_state(item_kind, item_id, status, injection_count, use_count, last_injected_at, last_used_at)
        VALUES (?, ?, 'warm', 0, 1, NULL, ?)
        ON CONFLICT(item_kind, item_id) DO UPDATE SET
          use_count = use_count + 1,
          last_used_at = excluded.last_used_at
        """,
        (kind, item_id, ts),
      )
  print(f"recorded {len(rows)} usage item(s)")


if __name__ == "__main__":
  try:
    main()
  except Exception as exc:
    print(f"record_usage failed: {exc}", file=sys.stderr)
    raise
