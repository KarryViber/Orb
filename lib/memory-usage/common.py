#!/usr/bin/env python3
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone


SCHEMA = """
CREATE TABLE IF NOT EXISTS injection_log (
  id INTEGER PRIMARY KEY,
  thread_id TEXT, turn_id TEXT, ts TEXT,
  item_kind TEXT,
  item_id TEXT,
  content_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_inject_item ON injection_log(item_kind, item_id);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY,
  thread_id TEXT, turn_id TEXT, ts TEXT,
  item_kind TEXT, item_id TEXT,
  evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_item ON usage_log(item_kind, item_id);

CREATE TABLE IF NOT EXISTS item_state (
  item_kind TEXT, item_id TEXT,
  status TEXT,
  injection_count INTEGER, use_count INTEGER,
  last_injected_at TEXT, last_used_at TEXT,
  PRIMARY KEY (item_kind, item_id)
);
"""


def utc_now():
  return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_db(db_path):
  os.makedirs(os.path.dirname(db_path), exist_ok=True)
  conn = sqlite3.connect(db_path)
  conn.executescript(SCHEMA)
  return conn


def read_json_stdin():
  raw = os.sys.stdin.read()
  return json.loads(raw) if raw.strip() else {}


def content_hash(content):
  return hashlib.sha256(str(content or "").encode("utf-8")).hexdigest()[:16]


def normalize_items(items):
  if not isinstance(items, list):
    return []
  out = []
  seen = set()
  for item in items:
    if not isinstance(item, dict):
      continue
    kind = str(item.get("item_kind") or item.get("kind") or "").strip()
    item_id = str(item.get("item_id") or item.get("id") or "").strip()
    if not kind or not item_id:
      continue
    key = (kind, item_id)
    if key in seen:
      continue
    seen.add(key)
    out.append({
      "item_kind": kind,
      "item_id": item_id,
      "content": str(item.get("content") or ""),
      "content_hash": item.get("content_hash") or content_hash(item.get("content") or item_id),
    })
  return out
