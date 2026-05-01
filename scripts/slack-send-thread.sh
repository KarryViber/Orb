#!/bin/bash
# ~/Orb/scripts/slack-send-thread.sh
# 通用 Slack 主消息 + Thread 发送脚本
# 支持：
# 1) 主消息纯文本
# 2) Thread 从 markdown 文件按 --- 分段发送（带色条 attachments）
# 3) Thread 直接发送 blocks JSON 文件（top-level blocks，非 attachment-only）
#
# 用法:
#   bash ~/Orb/scripts/slack-send-thread.sh \
#     --channel C0AP013V056 \
#     --main-msg "🔮 摘要文字" \
#     --thread-file /tmp/content.md \
#     --color "#1ABC9C"
#
#   bash ~/Orb/scripts/slack-send-thread.sh \
#     --channel CXXXXXXXXXX \
#     --main-msg "🏃 活动 04/05｜7,123步 420kcal HR58" \
#     --blocks-file /tmp/activity-blocks.json \
#     --color "#2eb886"
#
# 选项:
#   --channel      Slack 频道 ID（必填）
#   --main-msg     主消息文本（必填）
#   --thread-file  详情内容文件路径（按 --- 分段）
#   --blocks-file  Block Kit blocks JSON 文件路径（单条 attachment）
#   --color        色条颜色（默认 #5865F2）
#   --no-thread    只发主消息，不发 thread
#
# 约束:
#   --thread-file 与 --blocks-file 二选一

set -euo pipefail

CHANNEL=""
MAIN_MSG=""
THREAD_FILE=""
BLOCKS_FILE=""
COLOR="#5865F2"
NO_THREAD=false
MAX_CHARS=2800
RECEIPT_DIR="${SLACK_SEND_RECEIPT_DIR:-/Users/karry/Orb/data/receipts/slack-send-thread}"
mkdir -p "$RECEIPT_DIR"
RECEIPT_FILE="$RECEIPT_DIR/$(date '+%Y-%m-%d_%H-%M-%S')-$$.log"

log_receipt() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" | tee -a "$RECEIPT_FILE"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --main-msg) MAIN_MSG="$2"; shift 2 ;;
    --thread-file) THREAD_FILE="$2"; shift 2 ;;
    --blocks-file) BLOCKS_FILE="$2"; shift 2 ;;
    --color) COLOR="$2"; shift 2 ;;
    --no-thread) NO_THREAD=true; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$CHANNEL" || -z "$MAIN_MSG" ]]; then
  echo "❌ --channel 和 --main-msg 必填" >&2
  exit 1
fi

if [[ "$NO_THREAD" == false ]]; then
  if [[ -n "$THREAD_FILE" && -n "$BLOCKS_FILE" ]]; then
    echo "❌ --thread-file 和 --blocks-file 只能二选一" >&2
    exit 1
  fi
  if [[ -z "$THREAD_FILE" && -z "$BLOCKS_FILE" ]]; then
    echo "❌ 未指定 thread 内容：请传 --thread-file 或 --blocks-file，或使用 --no-thread" >&2
    exit 1
  fi
fi

if [[ -z "${SLACK_BOT_TOKEN:-}" ]] && [[ -f "/Users/karry/Orb/.env" ]]; then
  SLACK_BOT_TOKEN=$(python3 - <<'PY'
from pathlib import Path
for line in Path('/Users/karry/Orb/.env').read_text(encoding='utf-8').splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    if key.strip() == 'SLACK_BOT_TOKEN':
        print(value.strip().strip('"').strip("'"))
        break
PY
)
fi

if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  echo "❌ 无法从环境变量或 ~/Orb/.env 获取 SLACK_BOT_TOKEN" >&2
  exit 1
fi

MAIN_ERR=$(mktemp)
if ! MAIN_TS=$(SLACK_TOKEN="${SLACK_BOT_TOKEN}" SLACK_CHANNEL="$CHANNEL" SLACK_MAIN_MSG="$MAIN_MSG" python3 - <<'PYEOF' 2>"$MAIN_ERR"
import json, os, sys, urllib.request

token = os.environ['SLACK_TOKEN']
payload = json.dumps({
    'channel': os.environ['SLACK_CHANNEL'],
    'text': os.environ['SLACK_MAIN_MSG'],
    'unfurl_links': False,
    'unfurl_media': False,
}).encode('utf-8')

req = urllib.request.Request(
    'https://slack.com/api/chat.postMessage',
    data=payload,
    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json; charset=utf-8'},
    method='POST'
)
with urllib.request.urlopen(req, timeout=30) as resp:
    result = json.loads(resp.read().decode('utf-8'))
    if result.get('ok'):
        print(result['ts'])
    else:
        print(f"ERROR: {result.get('error')}", file=sys.stderr)
        sys.exit(1)
PYEOF
); then
  log_receipt "main status=failed channel=$CHANNEL error=$(tr '\n' ' ' < "$MAIN_ERR" | sed 's/[[:space:]]\+/ /g')"
  echo "❌ 主消息发送失败: $(cat "$MAIN_ERR")" >&2
  rm -f "$MAIN_ERR"
  exit 1
fi
rm -f "$MAIN_ERR"

if [[ -z "$MAIN_TS" ]]; then
  log_receipt "main status=failed channel=$CHANNEL error=empty-ts"
  echo "❌ 主消息发送失败" >&2
  exit 1
fi

log_receipt "main status=ok channel=$CHANNEL ts=$MAIN_TS"
echo "✅ 主消息 ts=$MAIN_TS"

if [[ "$NO_THREAD" == true ]]; then
  exit 0
fi

if [[ -n "$THREAD_FILE" ]]; then
  if [[ ! -f "$THREAD_FILE" ]]; then
    echo "❌ thread-file 不存在: $THREAD_FILE" >&2
    exit 1
  fi

  THREAD_ERR=$(mktemp)
  if ! THREAD_RESULT=$(python3 - << PYEOF 2>"$THREAD_ERR"
import json, urllib.request, urllib.error, sys
import re

token = """${SLACK_BOT_TOKEN}"""
thread_ts = """${MAIN_TS}"""
max_chars = ${MAX_CHARS}
content = open("""${THREAD_FILE}""", 'r', encoding='utf-8').read()

def sanitize_mrkdwn(text):
    text = re.sub(r'\*\*(.+?)\*\*', r'*\1*', text)
    text = re.sub(r'^\s{0,3}#{1,6}\s+(.+?)\s*$', r'*\1*', text, flags=re.MULTILINE)
    softened = []
    for line in text.splitlines():
        stripped = line.strip()
        if re.fullmatch(r'\*[^*\n]{1,80}\*', stripped):
            softened.append(line)
            continue
        softened.append(re.sub(r'\*([^*\n]{1,80})\*', r'\1', line))
    return '\n'.join(softened)

def plain_fallback(text):
    text = re.sub(r'[*_]+', '', text).replace(chr(96), '').strip()
    first = next((line.strip() for line in text.splitlines() if line.strip()), '详情')
    return first[:140]


def split_paragraphs(text):
    text = sanitize_mrkdwn(text).strip()
    if not text:
        return []
    text = re.sub(r'\n{3,}', '\n\n', text)
    return [p.strip() for p in re.split(r'\n\s*\n', text) if p.strip()]


def chunk_text(text, limit):
    text = text.strip()
    if not text:
        return []
    if len(text) <= limit:
        return [text]
    chunks = []
    current = []
    current_len = 0
    for line in text.splitlines():
        line = line.rstrip()
        add_len = len(line) + (1 if current else 0)
        if current and current_len + add_len > limit:
            chunks.append('\n'.join(current).strip())
            current = [line]
            current_len = len(line)
        else:
            current.append(line)
            current_len += add_len
    if current:
        joined = '\n'.join(current).strip()
        if joined:
            chunks.append(joined)
    return chunks


def blocks_from_part(part, limit):
    lines = part.strip().splitlines()
    heading = ''
    body_lines = lines
    if lines:
        m = re.match(r'^\s{0,3}#{1,6}\s+(.+?)\s*$', lines[0])
        if m:
            heading = sanitize_mrkdwn(m.group(1).strip())
            body_lines = lines[1:]
    body = '\n'.join(body_lines).strip()
    local_blocks = []
    if heading:
        local_blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"*{heading}*"}})
    paragraphs = split_paragraphs(body)
    if not paragraphs and body:
        paragraphs = [body]
    for para in paragraphs:
        for chunk in chunk_text(para, limit):
            local_blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": chunk}})
    return local_blocks

parts = [p.strip() for p in content.split('\n---\n') if p.strip()]
if not parts:
    parts = [content[:max_chars]] if content.strip() else []
if not parts:
    print("EMPTY_THREAD")
    sys.exit(0)
blocks = []
for idx, part in enumerate(parts):
    part_blocks = blocks_from_part(part, max_chars)
    if not part_blocks:
        continue
    if idx:
        blocks.append({"type": "divider"})
    blocks.extend(part_blocks)
if len(blocks) > 50:
    print(f"❌ Thread blocks 过多: {len(blocks)} > 50", file=sys.stderr)
    sys.exit(1)
fallback_text = plain_fallback(parts[0])
payload = json.dumps({
    "channel": "${CHANNEL}",
    "thread_ts": thread_ts,
    "text": fallback_text,
    "blocks": blocks,
    "unfurl_links": False,
    "unfurl_media": False
}).encode('utf-8')
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=payload,
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
    method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        if result.get("ok"):
            print(json.dumps({"status": "ok", "ts": result.get("ts"), "blocks": len(blocks)}, ensure_ascii=False))
        else:
            print(f"❌ Thread 失败: {result.get('error')}", file=sys.stderr)
            sys.exit(1)
except urllib.error.URLError as e:
    print(f"❌ 网络请求失败: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
  ); then
    log_receipt "thread status=failed channel=$CHANNEL main_ts=$MAIN_TS file=$THREAD_FILE error=$(tr '\n' ' ' < "$THREAD_ERR" | sed 's/[[:space:]]\+/ /g')"
    echo "❌ Thread 发送失败: $(cat "$THREAD_ERR")" >&2
    rm -f "$THREAD_ERR"
    exit 1
  fi
  rm -f "$THREAD_ERR"
  if [[ "$THREAD_RESULT" == "EMPTY_THREAD" ]]; then
    log_receipt "thread status=skipped channel=$CHANNEL main_ts=$MAIN_TS file=$THREAD_FILE reason=empty-thread"
    echo "⚠️ Thread 内容为空，跳过发送"
    exit 0
  fi
  log_receipt "thread status=ok channel=$CHANNEL main_ts=$MAIN_TS file=$THREAD_FILE result=$THREAD_RESULT"
  echo "✅ Thread 发送成功 $THREAD_RESULT"
  exit 0
fi

if [[ -n "$BLOCKS_FILE" ]]; then
  if [[ ! -f "$BLOCKS_FILE" ]]; then
    echo "❌ blocks-file 不存在: $BLOCKS_FILE" >&2
    exit 1
  fi

  BLOCKS_ERR=$(mktemp)
  if ! BLOCKS_RESULT=$(python3 - << PYEOF 2>"$BLOCKS_ERR"
import json, urllib.request, urllib.error, sys
import re

token = """${SLACK_BOT_TOKEN}"""
thread_ts = """${MAIN_TS}"""
color = """${COLOR}"""
blocks_path = """${BLOCKS_FILE}"""
with open(blocks_path, 'r', encoding='utf-8') as f:
    blocks = json.load(f)

def sanitize_mrkdwn(text):
    text = re.sub(r'\*\*(.+?)\*\*', r'*\1*', text)
    text = re.sub(r'^\s{0,3}#{1,6}\s+(.+?)\s*$', r'*\1*', text, flags=re.MULTILINE)
    softened = []
    for line in text.splitlines():
        stripped = line.strip()
        if re.fullmatch(r'\*[^*\n]{1,80}\*', stripped):
            softened.append(line)
            continue
        softened.append(re.sub(r'\*([^*\n]{1,80})\*', r'\1', line))
    return '\n'.join(softened)

def sanitize_blocks(node):
    if isinstance(node, dict):
        cleaned = {}
        for k, v in node.items():
            if k == 'text' and isinstance(v, str):
                cleaned[k] = sanitize_mrkdwn(v)
            else:
                cleaned[k] = sanitize_blocks(v)
        return cleaned
    if isinstance(node, list):
        return [sanitize_blocks(item) for item in node]
    return node

def first_text(node):
    if isinstance(node, dict):
        for key in ('text', 'fallback'):
            value = node.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in node.values():
            found = first_text(value)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = first_text(item)
            if found:
                return found
    return ''

blocks = sanitize_blocks(blocks)

if not isinstance(blocks, list) or not blocks:
    print("❌ blocks-file 必须是非空 JSON 数组", file=sys.stderr)
    sys.exit(1)

fallback_text = first_text(blocks)
fallback_text = re.sub(r'[*_]+', '', fallback_text).replace(chr(96), '').strip() or '详情'
fallback_text = fallback_text[:140]

payload = json.dumps({
    "channel": "${CHANNEL}",
    "thread_ts": thread_ts,
    "text": fallback_text,
    "blocks": blocks,
    "unfurl_links": False,
    "unfurl_media": False
}).encode('utf-8')
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=payload,
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
    method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        if result.get("ok"):
            print(json.dumps({"status": "ok", "ts": result.get("ts"), "blocks": len(blocks)}, ensure_ascii=False))
        else:
            print(f"❌ Blocks Thread 失败: {result.get('error')}", file=sys.stderr)
            sys.exit(1)
except urllib.error.URLError as e:
    print(f"❌ 网络请求失败: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
  ); then
    log_receipt "blocks_thread status=failed channel=$CHANNEL main_ts=$MAIN_TS file=$BLOCKS_FILE error=$(tr '\n' ' ' < "$BLOCKS_ERR" | sed 's/[[:space:]]\+/ /g')"
    echo "❌ Blocks Thread 发送失败: $(cat "$BLOCKS_ERR")" >&2
    rm -f "$BLOCKS_ERR"
    exit 1
  fi
  rm -f "$BLOCKS_ERR"
  log_receipt "blocks_thread status=ok channel=$CHANNEL main_ts=$MAIN_TS file=$BLOCKS_FILE result=$BLOCKS_RESULT"
  echo "✅ Blocks Thread 发送成功 $BLOCKS_RESULT"
fi
