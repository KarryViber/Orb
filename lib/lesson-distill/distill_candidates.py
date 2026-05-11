#!/usr/bin/env python3
import argparse
import json
import os
import re
import urllib.request
from pathlib import Path

import sys as _sys  # noqa: E402
ORB_ROOT = os.environ.get("ORB_ROOT")
if not ORB_ROOT:
  raise SystemExit("ORB_ROOT is required and must point to the Orb repository root")

_sys.path.insert(0, str(Path(ORB_ROOT) / "scripts" / "cron"))
import _import_root  # noqa: F401,E402  side effect: register canonical cron paths
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


NOISE_INJECT_KEYS = {"userText", "injectId", "origin", "parentAttemptId", "name", "kind"}


def is_noise_candidate(meta):
  """inject-failed candidates carrying only user follow-up text + ids are 系统级噪音：
  根因（worker session 在用户回复前已 exit）已被 lessons/inject-failed-null.md 覆盖，
  逐条 errorContext 没有诊断价值。Slack 审批卡只是噪音，直接归档。"""
  if meta.get("source") != "inject-failed":
    return False
  raw = meta.get("errorContext") or ""
  if not raw:
    return True
  try:
    obj = json.loads(raw.replace("\\\"", "\""))
  except (json.JSONDecodeError, ValueError):
    return False
  if not isinstance(obj, dict):
    return False
  return set(obj.keys()).issubset(NOISE_INJECT_KEYS)


def build_lesson_text(meta):
  source = meta.get("source") or "failure"
  stop = meta.get("stopReason") or "unknown"
  context = (meta.get("errorContext") or "").replace("\\n", " ").strip()
  lesson = f"When {source} reports {stop}, preserve the failure context as a reviewed lesson candidate before retrying."
  apply = f"Check thread_id={meta.get('thread_id') or 'unknown'} and the truncated error context, then decide whether to 收录 or 丢弃."
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


def slack_post(token, channel, blocks, text, thread_ts=None):
  body = {"channel": channel, "text": text, "blocks": blocks}
  if thread_ts:
    body["thread_ts"] = thread_ts
  req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
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
  source = meta.get("source", "unknown")
  cron_name = meta.get("cron_name")
  label = f"`{source}` · {cron_name}" if cron_name else f"`{source}`"
  return [
    {"type": "section", "text": {"type": "mrkdwn", "text": f"*Lesson candidate* {label} · _auto-archived_\n{lesson}\n\n*Context*\n{apply}"}},
    {"type": "context", "elements": [{"type": "mrkdwn", "text": f"`{candidate_path}`"}]},
  ]


def main():
  log = RunLog("failure-lesson-distill")
  parser = argparse.ArgumentParser()
  parser.add_argument("--data-dir", required=True)
  parser.add_argument("--channel", default=os.environ.get("LESSON_DISTILL_CHANNEL"))
  parser.add_argument("--channel-name", dest="channel_name", help="(deprecated) 4 层架构下统一走 evolution_state，无需 channel")
  parser.add_argument("--dry-run", action="store_true")
  args = parser.parse_args()

  candidates = sorted(Path(args.data_dir, "lesson-candidates").glob("*.md"))
  archive_dir = Path(args.data_dir, "lesson-candidates", ".archive")
  archive_dir.mkdir(exist_ok=True)
  processed = 0
  failed = 0
  noise_archived = 0
  first_error = None
  all_blocks: list[dict] = []
  approved_paths: list[tuple[Path, str, str, str]] = []  # (path, lesson, apply, original_text)

  for path in candidates:
    try:
      text = path.read_text(encoding="utf-8")
      meta = parse_frontmatter(text)
      if meta.get("status") != "pending_review":
        continue
      if is_noise_candidate(meta):
        path.rename(archive_dir / path.name)
        noise_archived += 1
        log.add_change("archived_noise", path, "inject-failed-no-diagnostic-info")
        continue
      processed += 1
      lesson, apply = build_lesson_text(meta)
      _source = meta.get('source', 'unknown')
      _cron_name = meta.get('cron_name')
      fallback = f"Lesson candidate: {_source} · {_cron_name}" if _cron_name else f"Lesson candidate: {_source}"
      blocks = card(path, meta, lesson, apply)
      validate_payload(path, blocks, fallback)

      if args.dry_run:
        print(json.dumps({"candidate": str(path), "lesson": lesson, "how_to_apply": apply, "blocks": blocks}, ensure_ascii=False))
        continue

      # 收集到批量 blocks（aggregator 会作为 thread reply 单条投递）
      all_blocks.extend(blocks)
      all_blocks.append({"type": "divider"})
      approved_paths.append((path, lesson, apply, text))
    except Exception as err:
      failed += 1
      message = f"{path}: {err}"
      log.add_error(f"candidate={path}", str(err))
      if first_error is None:
        first_error = message
      print(f"candidate_failed={json.dumps({'candidate': str(path), 'error': str(err)}, ensure_ascii=False)}")

  log.add_metric("processed", processed)
  log.add_metric("failed", failed)
  log.add_metric("noise_archived", noise_archived)

  if args.dry_run:
    print(f"dry_run processed={processed} failed={failed}")
    log.finish("partial" if failed else "ok")
    if failed:
      raise SystemExit(1)
    return

  # 写 evolution_state（即使 0 candidate 也写 silent，让 aggregator 知道这个 cron 跑过了）
  # path 已由模块顶部 _import_root 注入 profile scripts
  from evolution_state import write_cron_output

  date_md = __import__("datetime").datetime.now().strftime("%m/%d")
  if approved_paths:
    # 自进化频道统一标题协议：emoji + 中文名 MM/DD｜2-4 metric · 分隔
    title = f"🔁 失败蒸馏 {date_md}｜{processed} 候选 · 已归档"
    if all_blocks and all_blocks[-1].get("type") == "divider":
      all_blocks.pop()
    write_cron_output(
      cron_id="failure-lesson-distill",
      cron_name="failure-lesson-distill",
      title=title,
      blocks=all_blocks,
      status="failed" if failed else "ok",
      error=first_error if failed else None,
      schedule_label="每天 02:30 JST",
    )
    # 全权放权 (Karry 2026-05-03): 候选不再发审批卡，处置摘要写进 evolution thread 后直接归档。
    # 异常模式靠 Orb 在 thread 里回看 + 既有 lesson-monitor / quarterly-review 兜底。
    for path, lesson, apply, original in approved_paths:
      updated = original.replace("status: pending_review", "status: auto_archived", 1)
      if "## Distilled Lesson" not in updated:
        updated = updated.rstrip() + f"\n\n## Distilled Lesson\n{lesson}\n\n## How to apply\n{apply}\n"
      updated += f"\n\n<!-- lesson_distill_auto_archived: {date_md} -->\n"
      path.write_text(updated, encoding="utf-8")
      path.rename(archive_dir / path.name)
      log.add_change("auto_archived", path, "status=auto_archived")
  else:
    write_cron_output(
      cron_id="failure-lesson-distill",
      cron_name="failure-lesson-distill",
      title=f"🔁 失败蒸馏 {date_md}｜0 候选",
      status="silent",
      schedule_label="每天 02:30 JST",
    )

  if failed:
    print(f"failed: lesson-distill processed={processed} failed={failed}; first_error={first_error}")
    log.finish("partial" if approved_paths else "failed")
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
