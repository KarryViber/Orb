#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

prefix="boundary-guard-smoke-$$"
src_file="src/${prefix}.txt"
skill_dir="profiles/.claude/skills/${prefix}"
skill_file="${skill_dir}/SKILL.md"
data_file="profiles/<your-profile>/data/${prefix}.md"
base_head=$(git rev-parse HEAD)
old_hooks_path=$(git config --local --get core.hooksPath || true)

cleanup_paths=("$src_file" "$skill_file" "$data_file")

cleanup() {
  git reset --quiet "$base_head" >/dev/null 2>&1 || true
  git restore --staged -- "${cleanup_paths[@]}" >/dev/null 2>&1 || true
  rm -f -- "${cleanup_paths[@]}"
  rmdir "$skill_dir" >/dev/null 2>&1 || true
  if [[ -n "$old_hooks_path" ]]; then
    git config --local core.hooksPath "$old_hooks_path" >/dev/null 2>&1 || true
  else
    git config --local --unset core.hooksPath >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

git config --local core.hooksPath scripts/git-hooks
chmod +x scripts/git-hooks/pre-commit-boundary-guard.sh scripts/git-hooks/pre-commit scripts/git-hooks/commit-msg

pass_count=0

stage_file() {
  local path=$1
  mkdir -p "$(dirname "$path")"
  printf 'boundary guard smoke %s\n' "$RANDOM" >"$path"
  git add -f "$path"
}

reset_case() {
  git reset --quiet "$base_head"
  rm -f -- "${cleanup_paths[@]}"
  rmdir "$skill_dir" >/dev/null 2>&1 || true
}

expect_fail_bad_src() {
  reset_case
  stage_file "$src_file"
  if git commit -m "test: boundary guard bad src" >/tmp/${prefix}-case1.out 2>/tmp/${prefix}-case1.err; then
    echo "not ok 1 - bad src commit unexpectedly passed"
    return 1
  fi
  grep -q "拒绝提交" /tmp/${prefix}-case1.err
  echo "ok 1 - bad src commit rejected"
  pass_count=$((pass_count + 1))
}

expect_pass_good_src_lineage() {
  reset_case
  stage_file "$src_file"
  git commit -m $'test: boundary guard good src\n\nlineage: profiles/<your-profile>/workspace/specs/foo.md' >/tmp/${prefix}-case2.out 2>/tmp/${prefix}-case2.err
  echo "ok 2 - src commit with lineage accepted"
  pass_count=$((pass_count + 1))
}

expect_pass_skill_mcp_id() {
  reset_case
  stage_file "$skill_file"
  git commit -m $'test: boundary guard skill mcp\n\nmcp-proposal-id: 20260503xxx' >/tmp/${prefix}-case3.out 2>/tmp/${prefix}-case3.err
  echo "ok 3 - skill commit with mcp-proposal-id accepted"
  pass_count=$((pass_count + 1))
}

expect_pass_override_warns() {
  reset_case
  stage_file "$src_file"
  ORB_BOUNDARY_OVERRIDE=1 git commit -m "test: boundary guard override" >/tmp/${prefix}-case4.out 2>/tmp/${prefix}-case4.err
  grep -q "ORB_BOUNDARY_OVERRIDE=1" /tmp/${prefix}-case4.err
  echo "ok 4 - override accepted with warning"
  pass_count=$((pass_count + 1))
}

expect_pass_unprotected() {
  reset_case
  stage_file "$data_file"
  git commit -m "test: boundary guard unprotected data" >/tmp/${prefix}-case5.out 2>/tmp/${prefix}-case5.err
  echo "ok 5 - unprotected profile data accepted"
  pass_count=$((pass_count + 1))
}

expect_fail_bad_src
expect_pass_good_src_lineage
expect_pass_skill_mcp_id
expect_pass_override_warns
expect_pass_unprotected

reset_case
rm -f /tmp/${prefix}-case{1,2,3,4,5}.{out,err}

echo "boundary guard smoke: ${pass_count}/5 passed"
