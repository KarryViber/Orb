#!/usr/bin/env python3
"""Send Slack Block Kit messages with top-level blocks.

Usage:
    # From file:
    python3 slack-blockkit.py --channel CXXXXXXXXXX --text "Fallback" --color "#2eb886" --blocks blocks.json
    
    # From stdin:
    echo '[{"type":"section","text":{"type":"mrkdwn","text":"*Hello*"}}]' | python3 slack-blockkit.py --channel CXXXXXXXXXX --text "Fallback"
    
    # With thread:
    python3 slack-blockkit.py --channel CXXXXXXXXXX --thread 1234567890.123456 --text "Reply" --blocks blocks.json

Output: message timestamp (ts) on success, exits 1 on error.
"""

import argparse
import json
import sys
import urllib.request
import urllib.error


def get_slack_token():
    """Read Slack bot token from env or Orb profile .env."""
    import os

    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    if token:
        return token

    env_path = "/Users/karry/Orb/profiles/karry/.env"
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() == "SLACK_BOT_TOKEN":
                    value = value.strip().strip('"').strip("'")
                    if value:
                        return value

    raise RuntimeError("SLACK_BOT_TOKEN not found in environment or Orb profile .env")


def send_blockkit(channel, text, blocks, color="#2eb886", thread_ts=None):
    token = get_slack_token()

    body = {
        "channel": channel,
        "text": text,
        "blocks": blocks,
    }
    if thread_ts:
        body["thread_ts"] = thread_ts
    
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
    
    if not result.get("ok"):
        print(f"Slack API error: {result.get('error', 'unknown')}", file=sys.stderr)
        sys.exit(1)
    
    return result["ts"]


def main():
    parser = argparse.ArgumentParser(description="Send Slack Block Kit message")
    parser.add_argument("--channel", help="Slack channel ID（与 --channel-name 二选一）")
    parser.add_argument("--channel-name", dest="channel_name", help="Slack 频道名（从 config.json profiles.<profile>.channels 反查）")
    parser.add_argument("--thread", help="Thread timestamp for reply")
    parser.add_argument("--text", required=True, help="Fallback text / notification text")
    parser.add_argument("--color", default="#2eb886", help="兼容旧参数，已忽略")
    parser.add_argument("--blocks", help="JSON file with blocks array (reads stdin if omitted)")
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
    
    if args.blocks:
        with open(args.blocks) as f:
            blocks = json.load(f)
    else:
        blocks = json.load(sys.stdin)
    
    ts = send_blockkit(
        channel=args.channel,
        text=args.text,
        blocks=blocks,
        color=args.color,
        thread_ts=args.thread,
    )
    print(ts)


if __name__ == "__main__":
    main()
