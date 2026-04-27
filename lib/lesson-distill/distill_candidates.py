#!/usr/bin/env python3
import argparse
import json
import os
import re
import urllib.request
from pathlib import Path


FM_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def parse_frontmatter(text):
  match = FM_RE.match(text)
  if not match:
    return {}
  out = {}
  for line in match.group(1).splitlines():
    if ":" not in line:
      continue
    key, value = line.split(":", 1)
    out[key.strip()] = value.strip().strip('"')
  return out


def build_lesson_text(meta):
  source = meta.get("source") or "failure"
  stop = meta.get("stopReason") or "unknown"
  context = (meta.get("errorContext") or "").replace("\\n", " ").strip()
  lesson = f"When {source} reports {stop}, preserve the failure context as a reviewed lesson candidate before retrying."
  apply = f"Check thread_id={meta.get('thread_id') or 'unknown'} and the truncated error context, then decide whether to收录, merge, or discard."
  if context:
    apply += f" Context: {context[:180]}"
  return lesson, apply


def slack_post(token, channel, blocks, text):
  req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=json.dumps({"channel": channel, "text": text, "blocks": blocks}, ensure_ascii=False).encode("utf-8"),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
    method="POST",
  )
  with urllib.request.urlopen(req, timeout=15) as resp:
    payload = json.loads(resp.read().decode("utf-8"))
  if not payload.get("ok"):
    raise RuntimeError(payload.get("error") or "chat.postMessage failed")


def card(candidate_path, meta, lesson, apply):
  value = str(candidate_path)
  return [
    {"type": "section", "text": {"type": "mrkdwn", "text": f"*Lesson candidate* `{meta.get('source', 'unknown')}`\n{lesson}\n\n*How to apply*\n{apply}"}},
    {"type": "context", "elements": [{"type": "mrkdwn", "text": f"`{candidate_path}`"}]},
    {"type": "actions", "elements": [
      {"type": "button", "text": {"type": "plain_text", "text": "收录"}, "style": "primary", "action_id": "lesson_candidate_approve", "value": value},
      {"type": "button", "text": {"type": "plain_text", "text": "合并到 X"}, "action_id": "lesson_candidate_approve", "value": value},
      {"type": "button", "text": {"type": "plain_text", "text": "丢弃"}, "style": "danger", "action_id": "lesson_candidate_reject", "value": value},
    ]},
  ]


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--data-dir", required=True)
  parser.add_argument("--channel", default=os.environ.get("LESSON_DISTILL_CHANNEL", "CXXXXXXXXXX"))
  parser.add_argument("--dry-run", action="store_true")
  args = parser.parse_args()

  candidates = sorted(Path(args.data_dir, "lesson-candidates").glob("*.md"))
  token = os.environ.get("SLACK_BOT_TOKEN") or os.environ.get("SLACK_TOKEN")
  posted = 0
  for path in candidates:
    text = path.read_text(encoding="utf-8")
    meta = parse_frontmatter(text)
    if meta.get("status") != "pending_review":
      continue
    lesson, apply = build_lesson_text(meta)
    if args.dry_run:
      print(json.dumps({"candidate": str(path), "lesson": lesson, "how_to_apply": apply}, ensure_ascii=False))
    else:
      if not token:
        raise RuntimeError("SLACK_BOT_TOKEN required")
      slack_post(token, args.channel, card(path, meta, lesson, apply), f"Lesson candidate: {meta.get('source', 'unknown')}")
    updated = text.replace("status: pending_review", "status: approval_sent", 1)
    if "## Distilled Lesson" not in updated:
      updated = updated.rstrip() + f"\n\n## Distilled Lesson\n{lesson}\n\n## How to apply\n{apply}\n"
    path.write_text(updated, encoding="utf-8")
    posted += 1
  print(f"processed={posted}")


if __name__ == "__main__":
  main()
