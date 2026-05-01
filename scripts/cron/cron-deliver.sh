#!/bin/bash
# ~/Orb/scripts/cron/cron-deliver.sh
# Cron 任务统一交付脚本：主消息 + thread + reaction + 失败兜底 DM
#
# 两种模式：
#
# 1) 正常交付（成功路径）
#    bash cron-deliver.sh \
#      --cron-name "睡眠报告" \
#      --channel CXXXXXXXXXX \
#      --main-msg "🌙 睡眠 04/27｜7h · 深睡 14%｜节律 B+(78)" \
#      --reaction sleeping \
#      --blocks-file /tmp/sleep-blocks.json
#
# 2) 失败兜底 DM（替代各 prompt 自写 DM 逻辑）
#    bash cron-deliver.sh --on-fail-dm \
#      --cron-name "睡眠报告" \
#      --step "git-pull" \
#      --reason "shared-memory pull 冲突"
#
# 选项：
#   --cron-name     cron 任务名（必填，用于失败 DM 标题）
#   --channel       Slack 频道 ID（正常模式必填）
#   --channel-name  Slack 频道名（从 config.json profiles.<profile>.channels 反查 ID）
#   --main-msg      主消息文本（正常模式必填，必须符合公式 {emoji} {名} {日期}｜...）
#   --reaction      Slack reaction 名（不带冒号，如 sleeping / bird / chart_with_upwards_trend）
#   --thread-file   markdown thread（与 --blocks-file 二选一）
#   --blocks-file   Block Kit JSON thread（与 --thread-file 二选一）
#   --no-thread     仅发主消息
#   --color         attachment 色条（默认 #5865F2）
#   --on-fail-dm    切换到失败 DM 模式
#   --step          失败发生在哪一步（失败模式必填）
#   --reason        失败原因（失败模式必填，≤30 字）
#   --date          覆盖日期（默认 JST 当日 MM/DD）
#
# 退出码：
#   0 = 成功；1 = 参数错；2 = Slack API 错

set -euo pipefail

CRON_NAME=""
CHANNEL=""
CHANNEL_NAME=""
MAIN_MSG=""
REACTION=""
THREAD_FILE=""
BLOCKS_FILE=""
NO_THREAD=false
COLOR="#5865F2"
ON_FAIL_DM=false
STEP=""
REASON=""
DATE_OVERRIDE=""

# Profile owner DM channel for failure reports.
# 走 env 注入；缺失时 --on-fail-dm 模式会显式报错，避免在公开仓硬编码个人 channel id。
DM_CHANNEL="${ORB_FAILURE_DM_CHANNEL:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SLACK_SEND="$REPO_ROOT/scripts/slack/slack-send-thread.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cron-name) CRON_NAME="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --channel-name) CHANNEL_NAME="$2"; shift 2 ;;
    --main-msg) MAIN_MSG="$2"; shift 2 ;;
    --reaction) REACTION="$2"; shift 2 ;;
    --thread-file) THREAD_FILE="$2"; shift 2 ;;
    --blocks-file) BLOCKS_FILE="$2"; shift 2 ;;
    --no-thread) NO_THREAD=true; shift ;;
    --color) COLOR="$2"; shift 2 ;;
    --on-fail-dm) ON_FAIL_DM=true; shift ;;
    --step) STEP="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --date) DATE_OVERRIDE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

if [[ -n "$CHANNEL" && -n "$CHANNEL_NAME" ]]; then
  echo "❌ --channel 和 --channel-name 不能同时使用" >&2
  exit 1
fi

if [[ -n "$CHANNEL_NAME" ]]; then
  CHANNEL=$(python3 "$SCRIPT_DIR/channels-resolve.py" "$CHANNEL_NAME") || {
    echo "❌ failed to resolve channel name: $CHANNEL_NAME" >&2
    exit 64
  }
fi

if [[ -z "$CRON_NAME" ]]; then
  echo "❌ --cron-name 必填" >&2
  exit 1
fi

today_jst() {
  if [[ -n "$DATE_OVERRIDE" ]]; then
    echo "$DATE_OVERRIDE"
  else
    TZ=Asia/Tokyo date +%m/%d
  fi
}

# ── 失败 DM 模式 ──────────────────────────────────────────────
if [[ "$ON_FAIL_DM" == true ]]; then
  if [[ -z "$STEP" || -z "$REASON" ]]; then
    echo "❌ --on-fail-dm 模式需要 --step 和 --reason" >&2
    exit 1
  fi
  if [[ -z "$DM_CHANNEL" ]]; then
    echo "❌ --on-fail-dm 模式需要环境变量 ORB_FAILURE_DM_CHANNEL（profile owner DM channel id）" >&2
    exit 1
  fi
  DATE_STR=$(today_jst)
  DM_MSG="⚠️ ${CRON_NAME} ${DATE_STR}｜失败：${STEP}｜${REASON}"
  bash "$SLACK_SEND" \
    --channel "$DM_CHANNEL" \
    --main-msg "$DM_MSG" \
    --no-thread
  exit $?
fi

# ── 正常交付模式 ──────────────────────────────────────────────
if [[ -z "$CHANNEL" || -z "$MAIN_MSG" ]]; then
  echo "❌ --channel 和 --main-msg 必填（或使用 --on-fail-dm）" >&2
  exit 1
fi

# 调底层发送（thread 选项透传）
SEND_ARGS=(--channel "$CHANNEL" --main-msg "$MAIN_MSG" --color "$COLOR")
if [[ "$NO_THREAD" == true ]]; then
  SEND_ARGS+=(--no-thread)
elif [[ -n "$THREAD_FILE" ]]; then
  SEND_ARGS+=(--thread-file "$THREAD_FILE")
elif [[ -n "$BLOCKS_FILE" ]]; then
  SEND_ARGS+=(--blocks-file "$BLOCKS_FILE")
else
  echo "❌ 需要 --thread-file / --blocks-file / --no-thread 之一" >&2
  exit 1
fi

# 捕获主消息 ts（slack-send-thread.sh 输出 "✅ 主消息 ts=<ts>"）
SEND_OUT=$(bash "$SLACK_SEND" "${SEND_ARGS[@]}")
echo "$SEND_OUT"

if [[ -z "$REACTION" ]]; then
  exit 0
fi

MAIN_TS=$(printf '%s\n' "$SEND_OUT" | sed -n 's/^✅ 主消息 ts=\(.*\)$/\1/p' | head -1)
if [[ -z "$MAIN_TS" ]]; then
  echo "⚠️ 未能解析主消息 ts，跳过 reaction" >&2
  exit 0
fi

# 加 reaction
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
  echo "⚠️ SLACK_BOT_TOKEN 不可用，跳过 reaction" >&2
  exit 0
fi

SLACK_TOKEN="$SLACK_BOT_TOKEN" \
  REACTION_CHANNEL="$CHANNEL" \
  REACTION_TS="$MAIN_TS" \
  REACTION_NAME="$REACTION" \
  python3 - <<'PYEOF' || echo "⚠️ reaction 添加失败（非致命）" >&2
import json, os, sys, urllib.request
payload = json.dumps({
    'channel': os.environ['REACTION_CHANNEL'],
    'name': os.environ['REACTION_NAME'],
    'timestamp': os.environ['REACTION_TS'],
}).encode()
req = urllib.request.Request(
    'https://slack.com/api/reactions.add',
    data=payload,
    headers={'Authorization': f"Bearer {os.environ['SLACK_TOKEN']}", 'Content-Type': 'application/json'},
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        result = json.loads(r.read())
        if not result.get('ok') and result.get('error') != 'already_reacted':
            print(f"reaction error: {result.get('error')}", file=sys.stderr)
            sys.exit(1)
except Exception as e:
    print(f"reaction request failed: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF

echo "✅ reaction :${REACTION}: 已添加 ts=$MAIN_TS"
