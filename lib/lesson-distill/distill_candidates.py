#!/usr/bin/env python3
import argparse
import json
import os
import re
import urllib.request
from pathlib import Path

import sys as _sys  # noqa: E402
_sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "profiles" / "karry" / "scripts"))
from cron_run_log import RunLog  # noqa: E402


FM_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)
MAX_BLOCKS = 50
MAX_SECTION_TEXT = 3000
MAX_CONTEXT_ELEMENTS = 10
MAX_ACTION_ELEMENTS = 25
MAX_ACTION_ID = 255
MAX_BUTTON_TEXT = 75
MAX_BUTTON_VALUE = 2000


class PayloadValidationError(ValueError):
  pass


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


def validate_text(name, value, limit, allow_empty=False):
  if not isinstance(value, str):
    raise PayloadValidationError(f"{name} must be a string")
  if not value and not allow_empty:
    raise PayloadValidationError(f"{name} is empty")
  try:
    value.encode("utf-8")
  except UnicodeEncodeError as err:
    raise PayloadValidationError(f"{name} is not valid UTF-8: {err}") from err
  if len(value) > limit:
    raise PayloadValidationError(f"{name} too long: {len(value)} > {limit}")


def validate_blocks(blocks):
  if not isinstance(blocks, list) or not blocks:
    raise PayloadValidationError("blocks must be a non-empty list")
  if len(blocks) > MAX_BLOCKS:
    raise PayloadValidationError(f"too many blocks: {len(blocks)} > {MAX_BLOCKS}")

  for block_index, block in enumerate(blocks):
    block_type = block.get("type")
    prefix = f"blocks[{block_index}]"
    if block_type == "section":
      text = block.get("text") or {}
      validate_text(f"{prefix}.text.text", text.get("text"), MAX_SECTION_TEXT)
      if text.get("type") not in {"mrkdwn", "plain_text"}:
        raise PayloadValidationError(f"{prefix}.text.type invalid: {text.get('type')}")
    elif block_type == "context":
      elements = block.get("elements") or []
      if len(elements) > MAX_CONTEXT_ELEMENTS:
        raise PayloadValidationError(f"{prefix}.elements too many: {len(elements)} > {MAX_CONTEXT_ELEMENTS}")
      for element_index, element in enumerate(elements):
        validate_text(f"{prefix}.elements[{element_index}].text", element.get("text"), MAX_SECTION_TEXT)
    elif block_type == "actions":
      elements = block.get("elements") or []
      if not elements:
        raise PayloadValidationError(f"{prefix}.elements is empty")
      if len(elements) > MAX_ACTION_ELEMENTS:
        raise PayloadValidationError(f"{prefix}.elements too many: {len(elements)} > {MAX_ACTION_ELEMENTS}")
      seen_action_ids = set()
      for element_index, element in enumerate(elements):
        element_prefix = f"{prefix}.elements[{element_index}]"
        if element.get("type") != "button":
          raise PayloadValidationError(f"{element_prefix}.type invalid: {element.get('type')}")
        action_id = element.get("action_id")
        validate_text(f"{element_prefix}.action_id", action_id, MAX_ACTION_ID)
        if action_id in seen_action_ids:
          raise PayloadValidationError(f"{prefix} has duplicate action_id: {action_id}")
        seen_action_ids.add(action_id)
        text = element.get("text") or {}
        if text.get("type") != "plain_text":
          raise PayloadValidationError(f"{element_prefix}.text.type invalid: {text.get('type')}")
        validate_text(f"{element_prefix}.text.text", text.get("text"), MAX_BUTTON_TEXT)
        validate_text(f"{element_prefix}.value", element.get("value"), MAX_BUTTON_VALUE)
    else:
      raise PayloadValidationError(f"{prefix}.type unsupported: {block_type}")


def validate_payload(candidate_path, blocks, text):
  validate_text("fallback text", text, MAX_SECTION_TEXT)
  validate_blocks(blocks)
  value = str(candidate_path)
  validate_text("candidate path value", value, MAX_BUTTON_VALUE)


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
  if not payload.get("ts"):
    raise RuntimeError("chat.postMessage succeeded without ts")
  return payload


def card(candidate_path, meta, lesson, apply):
  value = str(candidate_path)
  return [
    {"type": "section", "text": {"type": "mrkdwn", "text": f"*Lesson candidate* `{meta.get('source', 'unknown')}`\n{lesson}\n\n*How to apply*\n{apply}"}},
    {"type": "context", "elements": [{"type": "mrkdwn", "text": f"`{candidate_path}`"}]},
    {"type": "actions", "elements": [
      {"type": "button", "text": {"type": "plain_text", "text": "收录"}, "style": "primary", "action_id": "lesson_candidate_approve", "value": value},
      {"type": "button", "text": {"type": "plain_text", "text": "合并到 X"}, "action_id": "lesson_candidate_merge", "value": value},
      {"type": "button", "text": {"type": "plain_text", "text": "丢弃"}, "style": "danger", "action_id": "lesson_candidate_reject", "value": value},
    ]},
  ]


def main():
  log = RunLog("failure-lesson-distill")
  parser = argparse.ArgumentParser()
  parser.add_argument("--data-dir", required=True)
  parser.add_argument("--channel", default=os.environ.get("LESSON_DISTILL_CHANNEL", "CXXXXXXXXXX"))
  parser.add_argument("--dry-run", action="store_true")
  args = parser.parse_args()

  candidates = sorted(Path(args.data_dir, "lesson-candidates").glob("*.md"))
  token = os.environ.get("SLACK_BOT_TOKEN") or os.environ.get("SLACK_TOKEN")
  processed = 0
  posted = 0
  failed = 0
  first_error = None
  for path in candidates:
    try:
      text = path.read_text(encoding="utf-8")
      meta = parse_frontmatter(text)
      if meta.get("status") != "pending_review":
        continue
      processed += 1
      lesson, apply = build_lesson_text(meta)
      fallback = f"Lesson candidate: {meta.get('source', 'unknown')}"
      blocks = card(path, meta, lesson, apply)
      validate_payload(path, blocks, fallback)

      if args.dry_run:
        print(json.dumps({"candidate": str(path), "lesson": lesson, "how_to_apply": apply, "blocks": blocks}, ensure_ascii=False))
        continue

      if not token:
        raise RuntimeError("SLACK_BOT_TOKEN required")
      result = slack_post(token, args.channel, blocks, fallback)
      updated = text.replace("status: pending_review", "status: approval_sent", 1)
      if "## Distilled Lesson" not in updated:
        updated = updated.rstrip() + f"\n\n## Distilled Lesson\n{lesson}\n\n## How to apply\n{apply}\n"
      updated += f"\n\n<!-- lesson_distill_slack_ts: {result['ts']} -->\n"
      path.write_text(updated, encoding="utf-8")
      log.add_change("updated", path, "status=approval_sent")
      posted += 1
    except Exception as err:
      failed += 1
      message = f"{path}: {err}"
      log.add_error(f"candidate={path}", str(err))
      if first_error is None:
        first_error = message
      print(f"candidate_failed={json.dumps({'candidate': str(path), 'error': str(err)}, ensure_ascii=False)}")

  log.add_metric("processed", processed)
  log.add_metric("posted", posted)
  log.add_metric("failed", failed)
  if args.dry_run:
    print(f"dry_run processed={processed} failed={failed}")
    log.finish("partial" if failed else "ok")
    if failed:
      raise SystemExit(1)
    return

  if failed:
    print(f"failed: lesson-distill processed={processed} posted={posted} failed={failed}; first_error={first_error}")
    log.finish("partial" if posted else "failed")
    raise SystemExit(1)

  log.finish("ok")
  print("[SILENT]")


if __name__ == "__main__":
  try:
    main()
  except Exception as err:
    fallback_log = RunLog("failure-lesson-distill")
    fallback_log.add_error("distill_candidates", str(err))
    fallback_log.finish("failed")
    raise
