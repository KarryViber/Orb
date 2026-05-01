#!/usr/bin/env bash
# slack-blockkit.sh — Send Slack Block Kit messages (attachments with color bar)
# Usage: slack-blockkit.sh --channel <id> [--thread <ts>] --text <fallback> --color <hex> --payload <json_file_or_stdin>
#
# The payload JSON should be an array of Slack blocks.
# Example: [{"type":"section","text":{"type":"mrkdwn","text":"*Hello*"}}]

set -euo pipefail

CHANNEL=""
THREAD=""
TEXT=""
COLOR="#2eb886"
PAYLOAD_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2;;
    --thread) THREAD="$2"; shift 2;;
    --text) TEXT="$2"; shift 2;;
    --color) COLOR="$2"; shift 2;;
    --payload) PAYLOAD_FILE="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

if [[ -z "$CHANNEL" || -z "$TEXT" ]]; then
  echo "Usage: slack-blockkit.sh --channel <id> --text <fallback> [--thread <ts>] [--color <hex>] [--payload <file>]" >&2
  exit 1
fi

# Read token from environment or ~/Orb/.env
TOKEN="${SLACK_BOT_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HOME/Orb/.env" ]]; then
  TOKEN=$(python3 - <<'PY'
from pathlib import Path
for line in Path.home().joinpath('Orb/.env').read_text(encoding='utf-8').splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    if k.strip() == 'SLACK_BOT_TOKEN':
        print(v.strip().strip('"').strip("'"))
        break
PY
)
fi
if [[ -z "$TOKEN" ]]; then
  echo "❌ 无法从环境变量或 ~/Orb/.env 获取 SLACK_BOT_TOKEN" >&2
  exit 1
fi

# Read blocks payload
if [[ -n "$PAYLOAD_FILE" && "$PAYLOAD_FILE" != "-" ]]; then
  BLOCKS=$(cat "$PAYLOAD_FILE")
else
  BLOCKS=$(cat)
fi

# Build JSON body (pass values via env to avoid shell/python quoting issues with newlines)
BODY=$(CHANNEL="$CHANNEL" TEXT="$TEXT" COLOR="$COLOR" THREAD="$THREAD" BLOCKS="$BLOCKS" python3 -c '
import json, os
blocks_str = os.environ.get("BLOCKS", "").strip()
body = {
    "channel": os.environ["CHANNEL"],
    "text": os.environ["TEXT"],
    "attachments": [{
        "color": os.environ["COLOR"],
        "blocks": json.loads(blocks_str) if blocks_str else []
    }]
}
thread = os.environ.get("THREAD", "")
if thread:
    body["thread_ts"] = thread
print(json.dumps(body, ensure_ascii=False))
')

# Send
RESULT=$(curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$BODY")

OK=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))")
if [[ "$OK" == "True" ]]; then
  TS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ts',''))")
  echo "$TS"
else
  echo "ERROR: $RESULT" >&2
  exit 1
fi
