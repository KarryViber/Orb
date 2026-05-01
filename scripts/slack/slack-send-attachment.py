#!/usr/bin/env python3
"""
slack-send-attachment.py — 向指定 thread 发送单条分段 blocks 消息。
兼容旧调用：保留 --color 参数，但不再发送 colored attachment。

用法:
  python3 slack-send-attachment.py \
    --channel CXXXXXXXXXX \
    --thread-ts 1234567890.123456 \
    --color "#e74c3c" \
    --header ":red_circle: *持仓标的*" \
    --body "正文内容（mrkdwn）"
"""

import argparse
import json
import os
import re
import urllib.request
from pathlib import Path


def load_token() -> str:
    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    if token:
        return token
    env_path = Path("/Users/karry/Orb/profiles/karry/.env")
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("SLACK_BOT_TOKEN="):
            continue
        value = line.split("=", 1)[1].strip().strip('"').strip("'")
        if value:
            return value
    raise SystemExit("SLACK_BOT_TOKEN not found")


def sanitize_mrkdwn(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)
    softened = []
    for line in text.splitlines():
        stripped = line.strip()
        if re.fullmatch(r"\*[^*\n]{1,60}\*", stripped):
            softened.append(line)
            continue
        softened.append(re.sub(r"\*([^*\n]{1,80})\*", r"\1", line))
    return "\n".join(softened)


def plain_fallback(header: str, body: str) -> str:
    raw = f"{header}\n{body}".strip()
    raw = re.sub(r"[*_]+", "", raw).replace(chr(96), "")
    first = next((line.strip() for line in raw.splitlines() if line.strip()), "详情")
    return first[:140]


parser = argparse.ArgumentParser()
parser.add_argument("--channel", help="Slack channel ID（与 --channel-name 二选一）")
parser.add_argument("--channel-name", dest="channel_name", help="Slack 频道名（从 config.json profiles.<profile>.channels 反查）")
parser.add_argument("--thread-ts", required=True)
parser.add_argument("--color", default="#5865F2", help="兼容旧参数，已忽略")
parser.add_argument("--header", default="")
parser.add_argument("--body", required=True)
args = parser.parse_args()
if args.channel_name and args.channel:
    parser.error("--channel 和 --channel-name 不能同时使用")
if args.channel_name:
    import subprocess
    args.channel = subprocess.check_output(
        ["python3", "/Users/karry/Orb/scripts/cron/channels-resolve.py", args.channel_name]
    ).decode().strip()
if not args.channel:
    parser.error("必须提供 --channel 或 --channel-name")
args.body = args.body.replace("\\n", "\n")

header = sanitize_mrkdwn(args.header.strip())
body = sanitize_mrkdwn(args.body.strip())
blocks = []
if header:
    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": header}})
if header and body:
    blocks.append({"type": "divider"})
if body:
    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": body}})
if not blocks:
    raise SystemExit("empty payload")

payload = json.dumps(
    {
        "channel": args.channel,
        "thread_ts": args.thread_ts,
        "text": plain_fallback(header, body),
        "blocks": blocks,
    }
).encode("utf-8")

req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=payload,
    headers={"Authorization": f"Bearer {load_token()}", "Content-Type": "application/json; charset=utf-8"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=30) as resp:
    result = json.loads(resp.read().decode())
    if not result.get("ok"):
        raise SystemExit(f"Slack error: {result.get('error')}")
    print(result["ts"])
