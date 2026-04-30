#!/usr/bin/env bash
# external-session-spawn.sh
# 后台派遣外部 LLM session（codex / claude code），完成后自动推 Slack 回报。
# 解决「派完要 Karry 催『好了吗？』」痛点：fork 后台跑 → exit 后 chat.postMessage 推回原 thread。
#
# 用法：
#   external-session-spawn.sh --engine codex \
#     --channel CXXXXXXXXXX \
#     --thread 1777479633.749609 \
#     --label "#1 run.json 审计" \
#     --log /tmp/codex-runjson.log \
#     --prompt "严格按 specs/cron-run-json-audit.md 执行..."
#
#   external-session-spawn.sh --engine claude \
#     --channel ... --thread ... --label "..." --log ... \
#     --prompt "实施 specs/xxx.md"
#
# 行为：
#   1. fork 后台 subshell 跑标准模板（codex 走 --cd ~/Orb + bypass + </dev/null + stderr 噪音过滤；
#      claude 走 -p prompt --dangerously-skip-permissions --output-format stream-json）
#   2. 主进程立即退出，输出后台 pid + log 路径
#   3. 后台 child 跑完后 curl chat.postMessage 推回原 thread：
#      ✅ codex 完成｜<label>｜log: <path>｜rc=0｜took 12s
#      ❌ codex 失败｜<label>｜rc=2｜tail of stderr...
#   4. Bot 自发消息默认不触发新 worker（adapter 忽略 self），不循环

set -euo pipefail

ENGINE=""; CHANNEL=""; THREAD=""; LABEL=""; LOG=""; PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)  ENGINE="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --thread)  THREAD="$2"; shift 2 ;;
    --label)   LABEL="$2"; shift 2 ;;
    --log)     LOG="$2"; shift 2 ;;
    --prompt)  PROMPT="$2"; shift 2 ;;
    *) echo "❌ unknown arg: $1" >&2; exit 64 ;;
  esac
done

for v in ENGINE CHANNEL THREAD LABEL LOG PROMPT; do
  if [[ -z "${!v}" ]]; then echo "❌ missing --${v,,}" >&2; exit 64; fi
done

case "$ENGINE" in
  codex|claude) ;;
  *) echo "❌ --engine must be 'codex' or 'claude' (got: $ENGINE)" >&2; exit 64 ;;
esac

# 加载 SLACK_BOT_TOKEN 早失败，避免后台跑完才发现没 token
if [[ -z "${SLACK_BOT_TOKEN:-}" ]] && [[ -f "/Users/karry/Orb/.env" ]]; then
  SLACK_BOT_TOKEN=$(python3 - <<'PY'
import os
with open("/Users/karry/Orb/.env") as f:
    for line in f:
        if line.startswith("SLACK_BOT_TOKEN="):
            print(line.split("=", 1)[1].strip().strip("'\""))
            break
PY
)
fi
if [[ -z "${SLACK_BOT_TOKEN:-}" ]]; then
  echo "❌ SLACK_BOT_TOKEN not in env or ~/Orb/.env" >&2; exit 1
fi

# 确保 log 父目录存在
mkdir -p "$(dirname "$LOG")"

# Fork 后台执行
(
  set +e
  start=$(date +%s)

  if [[ "$ENGINE" == "codex" ]]; then
    cd ~/Orb
    codex exec \
      --dangerously-bypass-approvals-and-sandbox \
      --cd ~/Orb \
      "$PROMPT" \
      </dev/null \
      >"$LOG" \
      2> >(grep -v "failed to record rollout items: thread" >> "$LOG")
  else
    # claude code 标准 -p 调用
    cd ~/Orb/profiles/karry/workspace
    claude -p "$PROMPT" \
      --dangerously-skip-permissions \
      </dev/null \
      >"$LOG" 2>&1
  fi
  rc=$?
  end=$(date +%s)
  took=$((end - start))

  # 失败时取 stderr/stdout 末 10 行做诊断
  tail_excerpt=""
  if [[ $rc -ne 0 ]]; then
    tail_excerpt=$(tail -10 "$LOG" 2>/dev/null | head -c 800)
  fi

  if [[ $rc -eq 0 ]]; then
    text="✅ ${ENGINE} 完成｜${LABEL}｜log: \`${LOG}\`｜took ${took}s"
  else
    text="❌ ${ENGINE} 失败｜${LABEL}｜rc=${rc}｜log: \`${LOG}\`｜took ${took}s"
    if [[ -n "$tail_excerpt" ]]; then
      text+=$'\n```\n'"$tail_excerpt"$'\n```'
    fi
  fi

  python3 - <<PY
import os, json
import urllib.request

payload = {
    "channel": "${CHANNEL}",
    "thread_ts": "${THREAD}",
    "text": ${text@Q},
}
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "Authorization": "Bearer ${SLACK_BOT_TOKEN}",
        "Content-Type": "application/json; charset=utf-8",
    },
)
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        if not body.get("ok"):
            print(f"[external-session-spawn] slack post not ok: {body.get('error')}", flush=True)
except Exception as e:
    print(f"[external-session-spawn] slack post failed: {e}", flush=True)
PY
) </dev/null >/dev/null 2>&1 &

CHILD_PID=$!
disown
echo "✅ ${ENGINE} 已派遣"
echo "   pid:   ${CHILD_PID}"
echo "   log:   ${LOG}"
echo "   label: ${LABEL}"
echo "   完成后会自动推回 ${CHANNEL}/${THREAD}"
