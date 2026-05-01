#!/bin/bash
# memory-lint.sh — memory policy guardrails
# Usage: bash scripts/memory-lint.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTEXT_MODULE="$REPO_ROOT/src/context.js"

WORKSPACE="${WORKSPACE:-$REPO_ROOT/profiles/karry/workspace}"
ORB_DATA="${ORB_DATA:-$REPO_ROOT/profiles/karry/data}"
LESSONS_DIR="$ORB_DATA/lessons"
CLAUDE_PROJECTS_ROOT="${CLAUDE_PROJECTS_ROOT:-$HOME/.claude/projects}"
ORPHAN_MEMORY_MD="$ORB_DATA/MEMORY.md"
LESSON_LIMIT="${LESSON_LIMIT:-80}"

FAILURES=0

# Single source of truth for cwd encoding lives in src/context.js.
encode_cwd() {
  node --input-type=module -e "
    import { pathToFileURL } from 'node:url';
    const { encodeCwd } = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(encodeCwd(process.argv[2]));
  " "$CONTEXT_MODULE" "$1"
}

record_failure() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

EXPECTED_ENCODED_CWD="$(encode_cwd "$WORKSPACE")"
EXPECTED_PROJECT_DIR="$CLAUDE_PROJECTS_ROOT/$EXPECTED_ENCODED_CWD"
EXPECTED_MEMORY_DIR="$EXPECTED_PROJECT_DIR/memory"

echo "=== Memory Policy Lint ==="
echo "workspace=$WORKSPACE"
echo "encoded_cwd=$EXPECTED_ENCODED_CWD"

# 1. lessons 活跃条目数阈值
if [ ! -d "$LESSONS_DIR" ]; then
  record_failure "lessons directory missing: $LESSONS_DIR"
else
  mapfile -t active_lessons < <(find "$LESSONS_DIR" -maxdepth 1 -type f -name '*.md' ! -name 'README.md' -print | sort)
  active_count="${#active_lessons[@]}"
  if [ "$active_count" -le "$LESSON_LIMIT" ]; then
    echo "OK: active lessons $active_count/$LESSON_LIMIT"
  else
    # quota 超标只警告，不杀 pipeline（避免一个配额问题挡掉反思/auto-memory/daily-notes 全链路）
    echo "WARN: active lessons $active_count exceed limit $LESSON_LIMIT (quota only, not blocking)"
  fi

  # 2. lessons 文件名必须 lower kebab-case
  for lesson_path in "${active_lessons[@]}"; do
    lesson_name="$(basename "$lesson_path" .md)"
    if [[ ! "$lesson_name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
      record_failure "lesson filename is not lower kebab-case: $(basename "$lesson_path")"
    fi
  done
  echo "OK: lesson filename scan complete (${active_count} files)"
fi

# 3. auto-memory path encoding 正确性
if [ ! -d "$CLAUDE_PROJECTS_ROOT" ]; then
  record_failure "Claude projects root missing: $CLAUDE_PROJECTS_ROOT"
elif [ -d "$EXPECTED_PROJECT_DIR" ]; then
  echo "OK: auto-memory project dir exists: $EXPECTED_PROJECT_DIR"
else
  case_mismatch=""
  while IFS= read -r candidate; do
    candidate_name="$(basename "$candidate")"
    if [ "${candidate_name,,}" = "${EXPECTED_ENCODED_CWD,,}" ]; then
      case_mismatch="$candidate_name"
      break
    fi
  done < <(find "$CLAUDE_PROJECTS_ROOT" -mindepth 1 -maxdepth 1 -type d -print)

  if [ -n "$case_mismatch" ]; then
    record_failure "auto-memory cwd encoding case mismatch: expected $EXPECTED_ENCODED_CWD, found $case_mismatch"
  else
    record_failure "auto-memory project dir missing: $EXPECTED_PROJECT_DIR"
  fi
fi

if [ -d "$EXPECTED_MEMORY_DIR" ]; then
  echo "OK: auto-memory memory dir exists: $EXPECTED_MEMORY_DIR"
else
  record_failure "auto-memory memory dir missing: $EXPECTED_MEMORY_DIR"
fi

# 4. 孤儿路径守卫
if [ -e "$ORPHAN_MEMORY_MD" ]; then
  record_failure "orphan memory file must not exist: $ORPHAN_MEMORY_MD"
else
  echo "OK: orphan memory file absent: $ORPHAN_MEMORY_MD"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "Memory policy lint failed: $FAILURES issue(s)"
  exit 1
fi

echo "Memory policy lint passed"
