#!/usr/bin/env bash
# PreToolUse hook: inject DocStore FTS hints before Glob/Grep.
# Non-blocking by design: errors, empty queries, empty hits, and timeout all
# exit 0 with no stdout so the original tool proceeds unchanged.

set -u

payload=$(cat 2>/dev/null || true)
[[ -z "$payload" ]] && exit 0

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
orb_root="$(cd "$script_dir/../.." >/dev/null 2>&1 && pwd)"
docquery="$orb_root/lib/docstore/docquery.py"

python3 - "$payload" "$docquery" "$orb_root" <<'PYEOF' 2>/dev/null || true
import json
import os
import subprocess
import sys

try:
    payload = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

if payload.get("tool_name") not in {"Glob", "Grep"}:
    sys.exit(0)

pattern = ((payload.get("tool_input") or {}).get("pattern") or "").strip()
if not pattern:
    sys.exit(0)

docquery = sys.argv[2]
orb_root = sys.argv[3]
python_bin = os.environ.get("PYTHON_PATH", "python3")

try:
    proc = subprocess.run(
        [python_bin, docquery, pattern, "--limit", "3", "--format=hint"],
        cwd=orb_root,
        capture_output=True,
        text=True,
        timeout=0.2,
        check=False,
    )
except Exception:
    sys.exit(0)

if proc.returncode != 0:
    sys.exit(0)

hint = "\n".join(line for line in proc.stdout.splitlines() if line.strip())
if not hint:
    sys.exit(0)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "DocStore 命中（参考但不替代）：\n" + hint,
    }
}, ensure_ascii=False))
PYEOF

exit 0
