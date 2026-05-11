#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ORB_ROOT = os.environ.get("ORB_ROOT")
if not ORB_ROOT:
  raise SystemExit("ORB_ROOT is required and must point to the Orb repository root")

sys.path.insert(0, str(Path(ORB_ROOT) / "scripts" / "cron"))
import _import_root  # noqa: F401,E402  side effect: register canonical cron paths
from cron_run_log import RunLog  # noqa: E402
from lib.archive_audit import append_archive_event  # noqa: E402


FM_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)
STALE_DAYS = 30
ARCHIVE_DAYS = 90
# M1 telemetry 上线日；上线后头 STALE_DAYS 天内 production 段全 skip，
# 避免「first_seen=NULL」的 skill 被立刻冤标 stale。
TELEMETRY_BOOTSTRAP_DATE = datetime(2026, 5, 2, tzinfo=timezone.utc)


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


def read_frontmatter(path):
  text = path.read_text(encoding="utf-8")
  match = FM_RE.match(text)
  if not match:
    return {}
  fm = {}
  for line in match.group(1).splitlines():
    if ":" not in line:
      continue
    key, value = line.split(":", 1)
    fm[key.strip()] = value.strip().strip("\"'")
  return fm


def use_count(conn, skill_md):
  row = conn.execute(
    "SELECT use_count FROM item_state WHERE item_kind='skill' AND item_id=?",
    (str(skill_md),),
  ).fetchone()
  return int(row[0]) if row else 0


def last_used_at(conn, skill_name):
  row = conn.execute(
    "SELECT last_used_at FROM item_state WHERE item_kind='skill' AND item_id=?",
    (skill_name,),
  ).fetchone()
  return row[0] if row and row[0] else None


def parse_ts(value):
  if not value:
    return None
  text = str(value).strip()
  if text.endswith("Z"):
    text = text[:-1] + "+00:00"
  try:
    parsed = datetime.fromisoformat(text)
  except ValueError:
    return None
  if parsed.tzinfo is None:
    parsed = parsed.replace(tzinfo=timezone.utc)
  return parsed.astimezone(timezone.utc)


def propose_archive_via_mcp(workspace_dir, skill_name, days, dry_run):
  if dry_run:
    return {"status": "dry_run", "skill": skill_name, "days": days}
  server = Path(workspace_dir) / "tools" / "skill-manager-mcp" / "server.py"
  if not server.exists():
    return {"error": f"skill-manager MCP server missing: {server}"}
  req = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "skill_archive",
      "arguments": {
        "name": skill_name,
        "scope": "profile",
        "reason": f"production skill stale: no auto-recall for {days} days",
        "days_unused": days,
      },
    },
  }
  env = os.environ.copy()
  env["ORB_WORKSPACE_DIR"] = str(workspace_dir)
  env.setdefault("ORB_ROOT", ORB_ROOT)
  proc = subprocess.run(
    ["python3", str(server)],
    input=json.dumps(req, ensure_ascii=False) + "\n",
    capture_output=True,
    text=True,
    timeout=30,
    env=env,
  )
  if proc.returncode != 0:
    return {"error": (proc.stderr or proc.stdout or f"exit {proc.returncode}")[:500]}
  lines = [line for line in proc.stdout.splitlines() if line.strip()]
  if not lines:
    return {"error": "empty MCP response"}
  try:
    return json.loads(lines[-1])
  except json.JSONDecodeError:
    return {"error": f"invalid MCP response: {lines[-1][:300]}"}


def main():
  log = RunLog("skill-promotion-tick")
  parser = argparse.ArgumentParser()
  parser.add_argument("--workspace-dir", required=True)
  parser.add_argument("--data-dir", required=True)
  parser.add_argument("--dry-run", action="store_true")
  args = parser.parse_args()

  skills_dir = Path(args.workspace_dir) / ".claude" / "skills"
  drafts_dir = skills_dir / "_drafts"
  archive_dir = skills_dir / "_archive"
  db_path = Path(args.data_dir) / "memory-usage.db"
  conn = sqlite3.connect(db_path) if db_path.exists() else sqlite3.connect(":memory:")
  promoted = 0
  archived = 0
  production_stale_marked = 0
  production_archive_proposed = 0
  now = datetime.now(timezone.utc)
  if not args.dry_run:
    archive_dir.mkdir(parents=True, exist_ok=True)

  drafts = sorted(item for item in drafts_dir.iterdir() if item.is_dir()) if drafts_dir.exists() else []
  for draft in drafts:
    skill_md = draft / "SKILL.md"
    if not skill_md.exists():
      continue
    count = use_count(conn, skill_md)
    age_weeks = (now - datetime.fromtimestamp(skill_md.stat().st_mtime, timezone.utc)) / timedelta(weeks=1)
    if count >= 3:
      target = skills_dir / draft.name
      if target.exists():
        target = skills_dir / f"{draft.name}-{now.strftime('%Y%m%d%H%M%S')}"
      if not args.dry_run:
        shutil.move(str(draft), str(target))
        update_frontmatter(target / "SKILL.md", {"stage": "production", "promoted_at": now.isoformat().replace("+00:00", "Z")})
        log.add_change("updated", target / "SKILL.md", "stage=production")
      promoted += 1
    elif age_weeks >= 12 and count == 0:
      target = archive_dir / draft.name
      if target.exists():
        target = archive_dir / f"{draft.name}-{now.strftime('%Y%m%d%H%M%S')}"
      if not args.dry_run:
        shutil.move(str(draft), str(target))
        append_archive_event(
          kind='skill', item_id=draft.stem, action='archived',
          source_cron='skill-promotion-tick',
          reason='stale draft (use_count threshold)',
          archived_to=str(target.relative_to(target.parents[2])),
          extra={'draft_path': str(draft)},
        )
        log.add_change("updated", target, "archived stale draft")
      archived += 1

  production_checked = 0
  production_skipped_no_telemetry = 0
  production_pinned = 0
  production_skipped_grace = 0
  bootstrap_age_days = (now - TELEMETRY_BOOTSTRAP_DATE).days
  in_grace = bootstrap_age_days < STALE_DAYS
  production_dirs = sorted(item for item in skills_dir.iterdir() if item.is_dir() and not item.name.startswith("_")) if skills_dir.exists() else []
  for skill_dir in production_dirs:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
      continue
    production_checked += 1
    fm = read_frontmatter(skill_md)
    if str(fm.get("pin", "")).lower() == "true":
      production_pinned += 1
      continue
    skill_name = fm.get("name") or skill_dir.name
    if in_grace:
      production_skipped_grace += 1
      continue
    last_used = parse_ts(last_used_at(conn, skill_name))
    if last_used is None:
      production_skipped_no_telemetry += 1
      continue
    days = (now - last_used).days
    if days >= ARCHIVE_DAYS and fm.get("stage") == "stale":
      result = propose_archive_via_mcp(skills_dir.parent.parent, skill_name, days, args.dry_run)
      if "error" in result:
        log.add_error("skill_archive", f"{skill_name}: {result['error']}")
      else:
        log.add_change("updated", skill_md, f"archive proposed (no use {days}d)")
        production_archive_proposed += 1
    elif days >= STALE_DAYS and fm.get("stage") != "stale":
      if not args.dry_run:
        update_frontmatter(skill_md, {"stage": "stale", "stale_marked_at": now.isoformat().replace("+00:00", "Z")})
        log.add_change("updated", skill_md, f"stage=stale (no use {days}d)")
      production_stale_marked += 1
  log.add_metric("drafts", len(drafts))
  log.add_metric("promoted", promoted)
  log.add_metric("archived", archived)
  log.add_metric("production_checked", production_checked)
  log.add_metric("production_pinned", production_pinned)
  log.add_metric("production_skipped_no_telemetry", production_skipped_no_telemetry)
  log.add_metric("production_skipped_grace", production_skipped_grace)
  log.add_metric("production_stale_marked", production_stale_marked)
  log.add_metric("production_archive_proposed", production_archive_proposed)
  log.finish("ok")
  print(
    f"drafts={len(list(drafts_dir.glob('*')))} promoted={promoted} archived={archived} "
    f"production_checked={production_checked} production_pinned={production_pinned} "
    f"production_no_telemetry={production_skipped_no_telemetry} "
    f"production_grace={production_skipped_grace} "
    f"production_stale_marked={production_stale_marked} "
    f"production_archive_proposed={production_archive_proposed}"
  )


if __name__ == "__main__":
  try:
    main()
  except Exception as err:
    fallback_log = RunLog("skill-promotion-tick")
    fallback_log.add_error("skill_promotion_tick", str(err))
    fallback_log.finish("failed")
    raise
