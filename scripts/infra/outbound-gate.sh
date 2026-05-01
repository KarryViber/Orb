#!/bin/bash
# outbound-gate.sh — 通用出口拦截器
# 用法：echo "内容" | bash scripts/outbound-gate.sh --channel <private|guild|public>
# 
# 拦截（EXIT 1）：个人信息（电话/地址）、内部路径、API key/token、NO_REPLY 混入
# 警告（EXIT 0 + stderr）：12位数字串、.env 格式、memory 标签/路径（public 时升级为拦截）

set -euo pipefail

CHANNEL="private"
while [[ $# -gt 0 ]]; do
  case $1 in
    --channel) CHANNEL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

INPUT=$(cat)
ERRORS=()
WARNINGS=()

# === 拦截规则 ===

# 个人信息
# 归一化：全角数字→半角、全角/特殊横线→半角横线、全角空格→半角空格
INPUT_NORM=$(echo "$INPUT" | sed 's/０/0/g; s/１/1/g; s/２/2/g; s/３/3/g; s/４/4/g; s/５/5/g; s/６/6/g; s/７/7/g; s/８/8/g; s/９/9/g; s/−/-/g; s/ー/-/g; s/－/-/g; s/　/ /g' | perl -CSDA -pe 's/[\x{200B}\x{200C}\x{200D}\x{FEFF}]//g')
# 半角 + 全角（归一化后统一匹配）: 080-1234-5678
if echo "$INPUT_NORM" | grep -qE '080-[0-9]{4}-[0-9]{4}'; then
  ERRORS+=("🚨 電話番号検出")
fi
# 空格分隔: 080 1234 5678
if echo "$INPUT_NORM" | grep -qE '080[[:space:]]+[0-9]{4}[[:space:]]+[0-9]{4}'; then
  ERRORS+=("🚨 電話番号検出（空格分隔）")
fi

if echo "$INPUT" | grep -qiE '〒[0-9]{3}-[0-9]{4}|世田谷区|八幡山'; then
  ERRORS+=("🚨 住所信息检出")
fi

# 内部路径
if echo "$INPUT" | grep -qE '/Users/karry|/home/karry|~/.hermes|~/Orb|/Orb/profiles'; then
  ERRORS+=("🚨 内部路径泄露")
fi

# API keys / tokens
if echo "$INPUT" | grep -qiE 'sk-[a-zA-Z0-9]{20,}|api[_-]?key\s*[:=]\s*\S{10,}|token\s*[:=]\s*\S{10,}'; then
  ERRORS+=("🚨 API key/token 检出")
fi

# NO_REPLY 混入
if echo "$INPUT" | grep -qF 'NO_REPLY'; then
  ERRORS+=("🚨 NO_REPLY 混入对外消息")
fi

# === 警告规则 ===

# 12位数字串
if echo "$INPUT" | grep -qE '[0-9]{12,}'; then
  WARNINGS+=("⚠️ 12位以上数字串（可能是 ID 泄露）")
fi

# .env 格式
if echo "$INPUT" | grep -qE '^[A-Z_]+=.+'; then
  WARNINGS+=("⚠️ .env 格式变量")
fi

# memory 标签/路径
if echo "$INPUT" | grep -qE '\[P[0-2]\]|memory/[0-9]{4}|MEMORY\.md|daily notes'; then
  WARNINGS+=("⚠️ memory 标签/路径引用")
fi

# 日文混入检测（中日混搭违规）
# 统计平假名+片假名字符占比，超过 15% 视为日文混入
JA_CHARS=$(echo "$INPUT" | perl -CSDA -ne 'print join("\n", /[\x{3040}-\x{309F}\x{30A0}-\x{30FF}]/g)' 2>/dev/null | wc -l | tr -d ' ')
TOTAL_CHARS=$(echo -n "$INPUT" | wc -m | tr -d ' ')
if [[ "$TOTAL_CHARS" -gt 20 && "$JA_CHARS" -gt 0 ]]; then
  JA_RATIO=$((JA_CHARS * 100 / TOTAL_CHARS))
  if [[ "$JA_RATIO" -ge 15 ]]; then
    WARNINGS+=("⚠️ 日文字符占比 ${JA_RATIO}%（中日混搭违规嫌疑）")
  fi
fi

# === Command Injection Detection（借鉴 CC Bash Command Prefix Detection） ===

# 命令替换注入: $(...) 或反引号包裹可执行命令 — 全 channel block
# 仅当内容含危险命令名时拦截，markdown 引用（如 `new_body is required`）放行
CMD_RE='(curl|wget|rm|ssh|scp|nc|python|node|bash|sh|eval|chmod|chown|kill|dd|mkfs|mount|exec)'
if echo "$INPUT" | grep -qE "\\\$\\([^)]*\\b${CMD_RE}\\b[^)]*\\)|\`[^\`]*\\b${CMD_RE}\\b[^\`]*\`"; then
  ERRORS+=("🚨 命令替换含危险命令（\$() 或反引号）— 注入拦截")
fi

# 换行符注入（命令中嵌入换行实现多命令执行）— 全 channel block
LINE_COUNT=$(echo "$INPUT" | wc -l | tr -d ' ')
if [[ "$LINE_COUNT" -ge 2 ]]; then
  if echo "$INPUT" | grep -qE '^\s*(curl|wget|rm|ssh|scp|nc|python|node|bash|sh|eval)\b'; then
    ERRORS+=("🚨 多行内容中检测到可执行命令 — 注入拦截")
  fi
fi

# 管道到危险命令 — 全 channel block
if echo "$INPUT" | grep -qE '\|\s*(bash|sh|eval|python|node|exec)\b'; then
  ERRORS+=("🚨 管道到可执行命令 — 注入拦截")
fi

# === Security Monitor 规则（借鉴 CC Security Monitor） ===

# Scope creep: 复合命令含危险操作 — 全 channel block
if echo "$INPUT" | grep -qE '(&&|;|\|\|)\s*(rm|curl|wget|ssh|scp)\b'; then
  ERRORS+=("🚨 复合命令含危险操作 — 注入拦截")
fi

# 分号链: cmd ; cmd — 全 channel block
if echo "$INPUT" | grep -qE '\S+\s*;\s*(curl|wget|rm|ssh|scp|nc|python|node|bash|sh|eval|cat|chmod|chown|kill|dd|mkfs|mount)\b'; then
  ERRORS+=("🚨 分号链检出 — 注入拦截")
fi

# 双管道链: cmd || cmd — 全 channel block
if echo "$INPUT" | grep -qE '\S+\s*\|\|\s*(curl|wget|rm|ssh|scp|nc|python|node|bash|sh|eval|cat|chmod|chown|kill|dd|mkfs|mount)\b'; then
  ERRORS+=("🚨 双管道链检出 — 注入拦截")
fi

# 延迟效果: cron/at/launchd 相关
if echo "$INPUT" | grep -qiE 'crontab|launchctl|at\s+[0-9]|systemctl\s+enable'; then
  WARNINGS+=("⚠️ 定时任务/服务注册（延迟效果）")
fi

# 凭证泄露：SSH key / 证书路径
if echo "$INPUT" | grep -qE '\.pem|id_rsa|id_ed25519|\.p12|\.pfx'; then
  ERRORS+=("🚨 凭证文件路径检出")
fi

# 内部 Slack/Discord channel ID 泄露（public 时）
if [[ "$CHANNEL" == "public" ]] && echo "$INPUT" | grep -qE 'C0[A-Z0-9]{10,}'; then
  WARNINGS+=("⚠️ 内部 channel ID 检出")
fi

# Orb 内部术语泄露（public 时）
if [[ "$CHANNEL" == "public" ]] && echo "$INPUT" | grep -qiE 'outbound-gate|phone-gate|orb eye|heartbeat_ok|sub-agent-spec'; then
  ERRORS+=("🚨 Orb 内部术语/系统名泄露")
fi

# public 频道：警告升级为拦截
if [[ "$CHANNEL" == "public" && ${#WARNINGS[@]} -gt 0 ]]; then
  for w in "${WARNINGS[@]}"; do
    ERRORS+=("${w/⚠️/🚨} (public 升级)")
  done
  WARNINGS=()
fi

# === 输出 ===
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo "❌ BLOCKED" >&2
  for e in "${ERRORS[@]}"; do
    echo "  $e" >&2
  done
  exit 1
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  for w in "${WARNINGS[@]}"; do
    echo "  $w" >&2
  done
fi

echo "$INPUT"
exit 0
