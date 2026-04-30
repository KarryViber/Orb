#!/bin/bash
# hardware-monitor.sh — 硬件健康监控（防 3/20 事故重演）
# 用法：bash scripts/hardware-monitor.sh [--json]
# 加入 HEARTBEAT 轮换检查（每天 1-2 次）
#
# 监控项：
# 1. 电池健康（循环次数 + 最大容量）
# 2. 磁盘使用率
# 3. 磁盘 SMART 状态
# 4. 内存压力
# 5. CPU 温度（如可用）
# 6. 系统运行时间
# 7. 异常关机记录

set -euo pipefail

JSON_MODE=false
[[ "${1:-}" == "--json" ]] && JSON_MODE=true

ALERTS=()
WARNINGS=()
INFO=()

# === 1. 电池健康 ===
BATTERY_JSON=$(system_profiler SPPowerDataType -json 2>/dev/null || true)
if [[ -n "$BATTERY_JSON" ]]; then
  CYCLE_COUNT=$(echo "$BATTERY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('SPPowerDataType',[{}])[0].get('sppower_battery_health_info',{}).get('sppower_battery_cycle_count','N/A'))" 2>/dev/null || echo "N/A")
  MAX_CAP_PCT=$(echo "$BATTERY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('SPPowerDataType',[{}])[0].get('sppower_battery_health_info',{}).get('sppower_battery_health_maximum_capacity','N/A'))" 2>/dev/null || echo "N/A")
  CONDITION=$(echo "$BATTERY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('SPPowerDataType',[{}])[0].get('sppower_battery_health_info',{}).get('sppower_battery_health','N/A'))" 2>/dev/null || echo "N/A")
  
  INFO+=("🔋 电池: ${MAX_CAP_PCT} 容量, ${CYCLE_COUNT} 循环, 状态: ${CONDITION}")
  
  # 提取数字百分比
  HEALTH_NUM=$(echo "$MAX_CAP_PCT" | grep -oE '[0-9]+' | head -1 || echo "100")
  if [[ -n "$HEALTH_NUM" && "$HEALTH_NUM" -lt 80 ]]; then
    ALERTS+=("🚨 电池健康度 ${MAX_CAP_PCT} < 80%")
  elif [[ -n "$HEALTH_NUM" && "$HEALTH_NUM" -lt 90 ]]; then
    WARNINGS+=("⚠️ 电池健康度 ${MAX_CAP_PCT} 开始下降")
  fi
fi

# === 2. 磁盘使用率 ===
DISK_USAGE=$(df -h / | tail -1 | awk '{print $5}' | tr -d '%')
INFO+=("💾 磁盘: ${DISK_USAGE}% 已用")
if [[ $DISK_USAGE -gt 90 ]]; then
  ALERTS+=("🚨 磁盘使用率 ${DISK_USAGE}% > 90%")
elif [[ $DISK_USAGE -gt 80 ]]; then
  WARNINGS+=("⚠️ 磁盘使用率 ${DISK_USAGE}% > 80%")
fi

# === 3. SMART 状态 ===
SMART_STATUS=$(diskutil info disk0 2>/dev/null | grep "SMART Status" | awk -F: '{print $2}' | xargs || echo "Unknown")
INFO+=("🔧 SMART: $SMART_STATUS")
if [[ "$SMART_STATUS" != "Verified" && "$SMART_STATUS" != "Unknown" ]]; then
  ALERTS+=("🚨 SMART 状态异常: $SMART_STATUS")
fi

# === 4. 内存压力 ===
MEM_PRESSURE=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{print $NF}' | tr -d '%' || echo "N/A")
if [[ "$MEM_PRESSURE" != "N/A" ]]; then
  INFO+=("🧠 内存空闲: ${MEM_PRESSURE}%")
  if [[ $MEM_PRESSURE -lt 10 ]]; then
    ALERTS+=("🚨 内存空闲 ${MEM_PRESSURE}% < 10%")
  elif [[ $MEM_PRESSURE -lt 20 ]]; then
    WARNINGS+=("⚠️ 内存空闲 ${MEM_PRESSURE}% < 20%")
  fi
fi

# === 5. 系统运行时间 ===
UPTIME=$(uptime | sed 's/.*up //' | sed 's/,.*//')
INFO+=("⏱️ Uptime: $UPTIME")

# === 6. 异常关机记录（过去24小时） ===
PANIC_COUNT=$(find /Library/Logs/DiagnosticReports -name "*.panic" -mtime -1 2>/dev/null | wc -l | tr -d '[:space:]')
# 用 last 命令快速检查异常关机，只统计过去24小时的 shutdown 事件，避免把旧记录和 root console 的重复行一起算进去
LAST_OUTPUT=$(last -1000 2>/dev/null || true)
ABNORMAL_SHUTDOWNS=$(LAST_OUTPUT="$LAST_OUTPUT" python3 - <<'PY'
import os
import re
from datetime import datetime, timedelta

now = datetime.now()
cutoff = now - timedelta(hours=24)
lines = os.environ.get('LAST_OUTPUT', '').splitlines()
shutdown_lines = [line.strip() for line in lines if line.startswith('shutdown time')]
seen = set()

def normalize(dt):
    if dt > now + timedelta(days=1):
        return dt.replace(year=dt.year - 1)
    return dt

def parse_with_current_year(text, fmt):
    try:
        parsed = datetime.strptime(f"{now.year} {text}", fmt)
        return normalize(parsed)
    except ValueError:
        return None

candidates = shutdown_lines
patterns = []
if not shutdown_lines:
    candidates = lines
    patterns.append((re.compile(r'((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2})\s+-\s+shutdown\b'), '%Y %a %b %d %H:%M'))
else:
    patterns.append((re.compile(r'^shutdown time\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2})$'), '%Y %a %b %d %H:%M'))

for raw in candidates:
    for pattern, fmt in patterns:
        match = pattern.search(raw.strip())
        if not match:
            continue
        dt = parse_with_current_year(match.group(1), fmt)
        if dt is None or dt < cutoff:
            continue
        seen.add(dt.strftime('%Y-%m-%d %H:%M'))
        break

print(len(seen))
PY
)
ABNORMAL_SHUTDOWNS=$(echo "$ABNORMAL_SHUTDOWNS" | tr -d '[:space:]')

if [[ $PANIC_COUNT -gt 0 ]]; then
  ALERTS+=("🚨 过去24小时有 ${PANIC_COUNT} 次 kernel panic")
fi
if [[ $ABNORMAL_SHUTDOWNS -gt 0 ]]; then
  WARNINGS+=("⚠️ 过去24小时有 ${ABNORMAL_SHUTDOWNS} 次异常关机")
fi
INFO+=("📋 24h panic: ${PANIC_COUNT}, 异常关机: ${ABNORMAL_SHUTDOWNS}")

# === 7. 磁盘 I/O 错误（系统日志，用 dmesg 快速检查） ===
IO_ERRORS=$(dmesg 2>/dev/null | grep -ci "I/O error" | tail -1 || echo "0")
IO_ERRORS=$(echo "$IO_ERRORS" | tr -d '[:space:]')
IO_ERRORS=${IO_ERRORS:-0}
if [[ $IO_ERRORS -gt 0 ]]; then
  WARNINGS+=("⚠️ dmesg 中有 ${IO_ERRORS} 条 I/O 错误")
fi

# === 输出 ===
if $JSON_MODE; then
  echo "{"
  echo "  \"alerts\": $(printf '%s\n' "${ALERTS[@]:-}" | python3 -c 'import sys,json; print(json.dumps([l for l in sys.stdin.read().strip().split("\n") if l]))'),"
  echo "  \"warnings\": $(printf '%s\n' "${WARNINGS[@]:-}" | python3 -c 'import sys,json; print(json.dumps([l for l in sys.stdin.read().strip().split("\n") if l]))'),"
  echo "  \"info\": $(printf '%s\n' "${INFO[@]:-}" | python3 -c 'import sys,json; print(json.dumps([l for l in sys.stdin.read().strip().split("\n") if l]))')"
  echo "}"
else
  echo "=== 硬件健康报告 ==="
  echo ""
  for i in "${INFO[@]}"; do echo "  $i"; done
  echo ""
  if [[ ${#ALERTS[@]} -gt 0 ]]; then
    echo "🚨 告警:"
    for a in "${ALERTS[@]}"; do echo "  $a"; done
  fi
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    echo "⚠️ 警告:"
    for w in "${WARNINGS[@]}"; do echo "  $w"; done
  fi
  if [[ ${#ALERTS[@]} -eq 0 && ${#WARNINGS[@]} -eq 0 ]]; then
    echo "✅ 全部正常"
  fi
fi

# 退出码：有 alert = 2，有 warning = 1，正常 = 0
[[ ${#ALERTS[@]} -gt 0 ]] && exit 2
[[ ${#WARNINGS[@]} -gt 0 ]] && exit 1
exit 0
