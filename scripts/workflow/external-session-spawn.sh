#!/usr/bin/env bash
# external-session-spawn.sh
# 后台派遣外部 LLM session（codex / claude code），完成后自动推 Slack 回报。
# 解决「派完要 Karry 催『好了吗？』」痛点：fork 后台跑 → exit 后 chat.postMessage 推回原 thread。
#
# 用法：
#   external-session-spawn.sh --engine codex \
#     --channel C0123456789 \
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
#   3. 后台 child 跑完后优先发 daemon IPC；daemon 投递 Slack 回报并 inject active worker：
#      ✅ codex 完成｜<label>｜log: <path>｜rc=0｜took 12s
#      ❌ codex 失败｜<label>｜rc=2｜tail of stderr...
#   4. daemon/socket 不可用时回退 chat.postMessage

set -euo pipefail

ENGINE=""; CHANNEL=""; THREAD=""; LABEL=""; LOG=""; PROMPT=""; SPEC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)  ENGINE="$2"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --thread)  THREAD="$2"; shift 2 ;;
    --label)   LABEL="$2"; shift 2 ;;
    --log)     LOG="$2"; shift 2 ;;
    --prompt)  PROMPT="$2"; shift 2 ;;
    --spec)    SPEC="$2"; shift 2 ;;
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

# spec 模式：把后置约束注入 prompt 前缀，让 codex 自己跑测试 + 清理
# launcher 只负责 git commit + 归档 + 串 next_spec（codex 因铁律不能动 git）
if [[ -n "$SPEC" && -f "$SPEC" ]]; then
  SPEC_PREFIX=$'【spec 模式后置约束 — 完成主任务后、退出前必须依次执行】\n\n1. 跑 spec 末尾「## 验收」段列出的所有测试命令，全绿才能继续；任一失败立即 exit 非零，不要继续清理或修补。\n2. 删除你在 /tmp 或 $TMPDIR 下创建的所有中间产物。\n3. 删除你在工作树里产生的 untracked 调试文件（你自己写的 log / scratch / debug-* 等）；不要碰 spec 未要求改的既存文件。\n4. 严禁执行任何 git 命令（包括 status/diff/add/commit/push/mv）。launcher 会通过比对 baseline 自动 stage 你改的文件并 commit；你执行任何 git 操作只会导致 stage 状态脏污 + commit 被 boundary-guard 拒。\n\n--- spec 任务开始 ---\n\n'
  PROMPT="${SPEC_PREFIX}${PROMPT}"
fi

# 加载 SLACK_BOT_TOKEN 早失败，避免后台跑完才发现没 token
if [[ -z "${SLACK_BOT_TOKEN:-}" ]] && [[ -f "~/Orb/.env" ]]; then
  SLACK_BOT_TOKEN=$(python3 - <<'PY'
import os
with open("~/Orb/.env") as f:
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

  # 心跳子进程：每 600s 推一条「⏳ 仍在跑」给 thread。
  # codex 跑完后 kill 它，所以 <10 分钟的短程任务不会触发心跳——直接 ✅。
  HEARTBEAT_INTERVAL=600
  (
    while true; do
      sleep "$HEARTBEAT_INTERVAL"
      elapsed=$(( $(date +%s) - start ))
      mins=$(( elapsed / 60 ))
      log_lines=$(wc -l <"$LOG" 2>/dev/null | tr -d ' ' || echo "0")
      hb_text="⏳ ${ENGINE} 仍在跑｜${LABEL}｜elapsed ${mins}m｜log ${log_lines} 行"
      python3 - <<HBPY 2>/dev/null
import json, urllib.request
try:
    urllib.request.urlopen(urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps({"channel": "${CHANNEL}", "thread_ts": "${THREAD}", "text": ${hb_text@Q}}).encode("utf-8"),
        headers={"Authorization": "Bearer ${SLACK_BOT_TOKEN}", "Content-Type": "application/json; charset=utf-8"},
    ), timeout=10).read()
except Exception:
    pass
HBPY
    done
  ) &
  HEARTBEAT_PID=$!

  dirty_paths() {
    git -C "$1" status --porcelain=v1 | while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      path=${line:3}
      if [[ "$path" == *" -> "* ]]; then
        printf '%s\n' "${path%% -> *}" "${path##* -> }"
      else
        printf '%s\n' "$path"
      fi
    done | sed '/^$/d' | sort -u
  }

  subtract_paths() {
    comm -23 <(printf '%s\n' "$1" | sed '/^$/d' | sort -u) <(printf '%s\n' "$2" | sed '/^$/d' | sort -u)
  }

  stage_paths() {
    repo=$1
    paths=$2
    [[ -z "$paths" ]] && return 0
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      git -C "$repo" add -- "$path"
    done <<< "$paths"
  }

  ORB_REPO="~/Orb"
  WS_REPO="~/Orb/profiles/<your-profile>/workspace"
  ORB_BASELINE_DIRTY=""
  WS_BASELINE_DIRTY=""
  if [[ -n "${SPEC}" && -f "${SPEC}" ]]; then
    ORB_BASELINE_DIRTY=$(dirty_paths "$ORB_REPO")
    WS_BASELINE_DIRTY=$(dirty_paths "$WS_REPO")
  fi

  if [[ "$ENGINE" == "codex" ]]; then
    cd ~/Orb
    # Codex 0.128.0+ 走 sandbox workspace-write 替代粗暴 bypass：
    #   - workdir / /tmp / $TMPDIR / ~/.codex/memories 在 sandbox 内可写
    #   - approval_policy=never 不阻塞
    #   - network 显式启用（npm install / git fetch / curl 都走得通）
    # 写域外（如 Karry 别处文件）会被拒，比 bypass 多一层护栏。
    codex exec \
      --sandbox workspace-write \
      -c approval_policy='"never"' \
      -c sandbox_workspace_write.network_access=true \
      --cd ~/Orb \
      "$PROMPT" \
</dev/null \
      >"$LOG" \
      2> >(grep -v "failed to record rollout items: thread" >> "$LOG")
  else
    # claude code 标准 -p 调用
    cd ~/Orb/profiles/<your-profile>/workspace
    claude -p "$PROMPT" \
      --dangerously-skip-permissions \
      </dev/null \
      >"$LOG" 2>&1
  fi
  rc=$?
  end=$(date +%s)
  took=$((end - start))

  # codex/claude 跑完，立即 kill 心跳子进程
  kill "$HEARTBEAT_PID" 2>/dev/null
  wait "$HEARTBEAT_PID" 2>/dev/null

  # 失败时取 stderr/stdout 末 10 行做诊断
  tail_excerpt=""
  if [[ $rc -ne 0 ]]; then
    tail_excerpt=$(tail -10 "$LOG" 2>/dev/null | head -c 800)
  fi

  if [[ $rc -eq 0 ]]; then
    text="✅ ${ENGINE} 完成｜${LABEL}｜log: \`${LOG}\`｜took ${took}s"
    # spec 模式后置：codex 已自跑测试 + 清理（rc=0 即通过），launcher 只做 commit + 归档 + 串联
    # 整段包在 if/then 里 + 每步 || true 防御，确保不让 set -uo pipefail 把 chat.postMessage 吞掉
    if [[ -n "${SPEC}" && -f "${SPEC}" ]]; then
      spec_err=""
      if ! git -C "$ORB_REPO" rev-parse --show-toplevel >/dev/null 2>&1; then
        spec_err="Orb repo not found"
      elif ! git -C "$WS_REPO" rev-parse --show-toplevel >/dev/null 2>&1; then
        spec_err="workspace repo not found"
      else
        spec_basename=$(basename "${SPEC}" .md)
        spec_title=$(grep -m1 '^# ' "${SPEC}" 2>/dev/null | sed 's/^# *//' || true)
        [[ -z "${spec_title:-}" ]] && spec_title="$spec_basename"
        spec_rel="profiles/<your-profile>/workspace/specs/$(basename "$SPEC")"
        commit_msg="codex: ${spec_title}"$'\n\n'"lineage: ${spec_rel}"$'\n\nCo-Authored-By: codex <noreply@openai.com>'
        today=$(date +%Y-%m-%d)
        archive_dir="${WS_REPO}/specs/.archive"
        mkdir -p "$archive_dir" 2>>"${LOG}" || true
        archive_path="${archive_dir}/${spec_basename}-${today}.md"
        n=2
        while [[ -e "$archive_path" ]]; do
          archive_path="${archive_dir}/${spec_basename}-${today}-${n}.md"; n=$((n+1))
        done
        next_spec=$(awk '/^---[[:space:]]*$/{n++;next} n==1 && /^next_spec:/{sub(/^next_spec:[ ]*/,""); gsub(/["'\'' ]/,""); print; exit}' "${SPEC}" 2>>"${LOG}" || true)
        spec_worktree_path="specs/$(basename "$SPEC")"
        archive_worktree_path="specs/.archive/$(basename "$archive_path")"
        if ! git -C "$WS_REPO" mv "$spec_worktree_path" "$archive_worktree_path" 2>>"${LOG}"; then
          mv "${SPEC}" "$archive_path" 2>>"${LOG}" || spec_err="archive move failed"
        fi
        if [[ -z "$spec_err" ]]; then
          orb_modified=$(dirty_paths "$ORB_REPO")
          ws_modified=$(dirty_paths "$WS_REPO")
          orb_to_stage=$(subtract_paths "$orb_modified" "$ORB_BASELINE_DIRTY")
          ws_to_stage=$(subtract_paths "$ws_modified" "$WS_BASELINE_DIRTY")

          if [[ -n "$orb_to_stage" ]]; then
            if stage_paths "$ORB_REPO" "$orb_to_stage" 2>>"${LOG}" && git -C "$ORB_REPO" commit -m "$commit_msg" >>"${LOG}" 2>&1; then
              orb_commit=$(git -C "$ORB_REPO" rev-parse --short HEAD 2>>"${LOG}" || true)
              text+=$'\n✏️ Orb commit：'"${orb_commit:-unknown}"
            else
              spec_err="Orb commit failed; staged state preserved"
              text+=$'\n⚠️ Orb commit 失败，看 log: `'"${LOG}"'`'
            fi
          else
            text+=$'\n✏️ Orb commit：无新增改动'
          fi

          if [[ -z "$spec_err" ]]; then
            if [[ -n "$ws_to_stage" ]]; then
              if stage_paths "$WS_REPO" "$ws_to_stage" 2>>"${LOG}" && git -C "$WS_REPO" commit -m "spec(${spec_basename}): 归档" >>"${LOG}" 2>&1; then
                ws_commit=$(git -C "$WS_REPO" rev-parse --short HEAD 2>>"${LOG}" || true)
                text+=$'\n📦 workspace commit：'"${ws_commit:-unknown} $(basename "$archive_path")"
              else
                spec_err="workspace commit failed; staged state preserved"
                text+=$'\n⚠️ workspace commit 失败，看 log: `'"${LOG}"'`'
              fi
            else
              text+=$'\n📦 workspace commit：无新增改动'
            fi
          fi
        else
          text+=$'\n⚠️ spec post-process 出错: '"$spec_err"$' (chat.postMessage 仍会发)'
        fi
      fi
      if [[ -n "$spec_err" && "$spec_err" != "Orb commit failed; staged state preserved" && "$spec_err" != "workspace commit failed; staged state preserved" ]]; then
        text+=$'\n⚠️ spec post-process 出错: '"$spec_err"
      fi
      # 串联 next_spec
      if [[ -n "${next_spec:-}" ]]; then
        [[ "$next_spec" != /* ]] && next_spec="~/Orb/profiles/<your-profile>/workspace/${next_spec}"
        if [[ -f "$next_spec" ]]; then
          next_label="${LABEL} → next:$(basename "$next_spec" .md)"
          next_log="/tmp/codex-chain-$(date +%s).log"
          next_prompt="严格按 ${next_spec} 执行。\n\n--- spec 内容开始 ---\n$(cat "$next_spec")"
          nohup "$0" --engine "$ENGINE" --channel "$CHANNEL" --thread "$THREAD" \
            --label "$next_label" --log "$next_log" \
            --prompt "$next_prompt" --spec "$next_spec" \
            </dev/null >/dev/null 2>&1 &
          disown
          text+=$'\n🔗 串联：'"${next_label}"
        else
          text+=$'\n⚠️ next_spec 找不到：'"${next_spec}"
        fi
      fi
    fi
  else
    text="❌ ${ENGINE} 失败｜${LABEL}｜rc=${rc}｜log: \`${LOG}\`｜took ${took}s"
    if [[ -n "$tail_excerpt" ]]; then
      text+=$'\n```\n'"$tail_excerpt"$'\n```'
    fi
  fi

  # text/channel/thread/token via env to avoid bash→python quoting bugs
  # （历史踩坑：${text@Q} 在含换行时输出 $'...' ANSI-C quoting，python 不识别 → SyntaxError → 整段 silent fail）
  SLACK_POST_TEXT="$text" \
  SLACK_POST_CHANNEL="$CHANNEL" \
  SLACK_POST_THREAD="$THREAD" \
  SLACK_POST_TOKEN="$SLACK_BOT_TOKEN" \
  LAUNCHER_LABEL="$LABEL" \
  LAUNCHER_RC="$rc" \
  LAUNCHER_TOOK="$took" \
  LAUNCHER_LOG="$LOG" \
  LAUNCHER_SPEC_ARCHIVED="${archive_path:-}" \
  LAUNCHER_NEXT_SPEC="${next_spec:-}" \
  python3 - <<'PY'
import os, json, socket, tempfile, urllib.request
payload = {
    "type": "external_session_result",
    "channel": os.environ["SLACK_POST_CHANNEL"],
    "thread_ts": os.environ["SLACK_POST_THREAD"],
    "label": os.environ["LAUNCHER_LABEL"],
    "rc": int(os.environ["LAUNCHER_RC"]),
    "took_seconds": int(os.environ["LAUNCHER_TOOK"]),
    "log_path": os.environ["LAUNCHER_LOG"],
    "spec_archived": os.environ.get("LAUNCHER_SPEC_ARCHIVED") or None,
    "next_spec": os.environ.get("LAUNCHER_NEXT_SPEC") or None,
    "text": os.environ["SLACK_POST_TEXT"],
}
runtime_dir = os.environ.get("ORB_RUNTIME") or os.path.join(tempfile.gettempdir(), "orb-runtime")
socket_path = os.environ.get("ORB_EXTERNAL_SESSION_SOCKET") or os.path.join(runtime_dir, "external-session.sock")
sent_ipc = False
try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        client.connect(socket_path)
        client.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        sent_ipc = True
except Exception as e:
    print(f"[external-session-spawn] daemon ipc failed, fallback slack: {e}", flush=True)

if not sent_ipc:
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps({
            "channel": payload["channel"],
            "thread_ts": payload["thread_ts"],
            "text": payload["text"],
        }).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {os.environ['SLACK_POST_TOKEN']}",
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
) </dev/null >>"${LOG}.dispatch" 2>&1 &

CHILD_PID=$!
disown
echo "✅ ${ENGINE} 已派遣"
echo "   pid:   ${CHILD_PID}"
echo "   log:   ${LOG}"
echo "   label: ${LABEL}"
echo "   完成后会自动推回 ${CHANNEL}/${THREAD}"
