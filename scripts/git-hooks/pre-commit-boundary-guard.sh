#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
cd "$repo_root"

hook_name=${ORB_BOUNDARY_HOOK_NAME:-$(basename "${0:-boundary-guard}")}
msg_file=${1:-}

mapfile -t protected_paths < <(
  git diff --cached --name-only --diff-filter=ACMRTUXB |
    awk '
      /^src\// { print; next }
      /^\.claude\/skills\// { print; next }
      /^profiles\/\.claude\/skills\// { print; next }
      /^package\.json$/ { print; next }
      /^config\.json$/ { print; next }
      /^start\.sh$/ { print; next }
    '
)

if [[ ${#protected_paths[@]} -eq 0 ]]; then
  exit 0
fi

if [[ "${ORB_BOUNDARY_OVERRIDE:-}" == "1" ]]; then
  {
    echo "[repo-boundary-guard] 警告：ORB_BOUNDARY_OVERRIDE=1 已显式越权放行受保护路径提交。"
    printf '受保护路径：\n'
    printf '  - %s\n' "${protected_paths[@]}"
  } >&2
  exit 0
fi

message=""
if [[ -n "$msg_file" && -f "$msg_file" ]]; then
  message=$(cat "$msg_file")
elif [[ -n "${ORB_BOUNDARY_COMMIT_MSG_FILE:-}" && -f "${ORB_BOUNDARY_COMMIT_MSG_FILE:-}" ]]; then
  message=$(cat "$ORB_BOUNDARY_COMMIT_MSG_FILE")
elif [[ -n "${ORB_BOUNDARY_COMMIT_MSG:-}" ]]; then
  message=$ORB_BOUNDARY_COMMIT_MSG
elif [[ "$hook_name" != "pre-commit" && -f "$(git rev-parse --git-path COMMIT_EDITMSG)" ]]; then
  message=$(cat "$(git rev-parse --git-path COMMIT_EDITMSG)")
fi

if [[ -z "$message" && "$hook_name" == "pre-commit" ]]; then
  echo "[repo-boundary-guard] pre-commit 已发现受保护路径；commit message 校验延后到 commit-msg。" >&2
  exit 0
fi

if printf '%s\n' "$message" | grep -Eq '(specs/[^[:space:]]*\.md|lineage:|mcp-proposal-id:)'; then
  exit 0
fi

{
  echo "[repo-boundary-guard] 拒绝提交：受保护路径需要 commit message lineage 授权。"
  printf '受保护路径：\n'
  printf '  - %s\n' "${protected_paths[@]}"
  echo
  echo "修复方式："
  echo "  - 在 commit message 加入 lineage: profiles/<your-profile>/workspace/specs/<name>.md"
  echo "  - 或引用 specs/<name>.md"
  echo "  - skill-manager MCP 落盘提交使用 mcp-proposal-id: <id>"
  echo "  - 紧急越权：ORB_BOUNDARY_OVERRIDE=1 git commit ..."
} >&2

exit 1
