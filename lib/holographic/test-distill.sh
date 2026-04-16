#!/bin/bash
# 端到端测试：distill.py → holographic add → DB 查询 source 列
# 用法: bash test-distill.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="/tmp/test-evolution-$$.db"
REAL_DB="$HOME/Orb/profiles/karry/data/memory.db"

cleanup() { rm -f "$DB"; }
trap cleanup EXIT

echo "[1] 初始化测试 DB (schema from real DB)"
sqlite3 "$REAL_DB" ".schema" | sqlite3 "$DB"

echo "[2] 触发 distill.py（模拟 ENOENT 错误）"
INPUT='{"userText":"读取 /nonexistent 文件","errorText":"ENOENT: no such file or directory, open /nonexistent","responseText":""}'
DISTILL_OUT=$(echo "$INPUT" | python3 "$SCRIPT_DIR/distill.py")
echo "distill 输出: $DISTILL_OUT"

# 检查输出是否为合法 JSON 数组
COUNT=$(echo "$DISTILL_OUT" | python3 -c "import sys,json; data=json.load(sys.stdin); print(len(data))")
echo "[3] 蒸馏得到 $COUNT 条 lesson"

if [ "$COUNT" -eq 0 ]; then
  echo "WARN: distill 返回空数组，检查 ANTHROPIC_API_KEY 或网络"
fi

echo "[4] 检查输出包含 source 字段"
HAS_SOURCE=$(echo "$DISTILL_OUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('SKIP')
elif all('source' in item for item in data):
    print('OK')
else:
    missing = [i for i,x in enumerate(data) if 'source' not in x]
    print(f'MISSING at indices {missing}')
")
echo "source 字段检查: $HAS_SOURCE"

echo "[5] 写入测试 DB 并查询 source 列"
if [ "$COUNT" -gt 0 ]; then
  FIRST_LESSON=$(echo "$DISTILL_OUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(json.dumps(data[0]))
")
  CONTENT=$(echo "$FIRST_LESSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('content','test'))")
  SOURCE=$(echo "$FIRST_LESSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('source','unknown'))")

  python3 "$SCRIPT_DIR/bridge.py" "$DB" add \
    "{\"content\": $(echo "$CONTENT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))"), \"category\": \"lesson\", \"source\": \"$SOURCE\"}"

  STORED=$(sqlite3 "$DB" "SELECT content, source FROM facts WHERE category='lesson' LIMIT 1;")
  echo "DB 查询结果: $STORED"

  if echo "$STORED" | grep -q "$SOURCE"; then
    echo "[OK] source 列写入验证通过: $SOURCE"
  else
    echo "[FAIL] source 列未正确写入"
    exit 1
  fi
else
  echo "[SKIP] 无 lesson 可写入（distill 返回空）"
fi

echo ""
echo "=== test-distill.sh 完成 ==="
