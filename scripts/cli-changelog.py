#!/usr/bin/env python3
"""Fetch GitHub release notes between two versions for a CLI tool and summarize Orb-relevant highlights via Codex.

Usage:
    cli-changelog.py <tool> <old_ver> <new_ver>

Output:
    JSON array of ≤3 strings to stdout. Empty array [] if nothing relevant or on error.
"""
import json
import os
import re
import subprocess
import sys
from urllib.request import Request, urlopen

REPO_SLUGS = {
    'claude':  'anthropics/claude-code',
    'codex':   'openai/codex',
    'opencli': 'jackwener/opencli',
    'twitter': 'jackwener/twitter-cli',
}

CODEX_MODEL = os.environ.get('CODEX_MODEL', 'gpt-5.4')


def clean_ver(s: str) -> tuple:
    m = re.search(r'(\d+)\.(\d+)\.(\d+)', s or '')
    if not m:
        return (0, 0, 0)
    return tuple(int(x) for x in m.groups())


def fetch_releases(slug: str):
    url = f'https://api.github.com/repos/{slug}/releases?per_page=30'
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'orb-cli-changelog'}
    token = os.environ.get('GITHUB_TOKEN', '').strip()
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = Request(url, headers=headers)
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def summarize_via_codex(tool: str, old_ver: str, new_ver: str, notes_text: str) -> list:
    is_claude = tool == 'claude'
    extra_emphasis = ''
    if is_claude:
        extra_emphasis = '\n\n**特别强调**：claude 是 Orb 的 runtime 基座（Orb 是 Claude Code CLI fork）。任何新 hook / slash command / settings 字段 / session 机制 / MCP 变化 / auto-discovery 规则 / memory 行为 / 工具 API 都可能直接影响 Orb 架构，务必捕捉；不要只挑 "用户面" 变更。'

    prompt = f"""你在分析 CLI 工具 `{tool}` 从 `{old_ver}` 升级到 `{new_ver}` 的 release notes。

Orb 是 Karry 的单用户 agent 框架：基于 Claude Code CLI fork，通过 Slack 收消息 → fork worker 跑 Claude CLI → 回发。分层记忆 (holographic SQLite) + cron + skill (CLI auto-discover) + per-profile workspace。

任务：从 release notes 里挑出 **对 Orb 可能有实际用途** 的变更（新特性、新 API、架构能力、性能变化），**跳过**：bug fix / typo / CI / UI 美化 / 纯 IDE 集成 / 多用户 / SaaS 场景特性。{extra_emphasis}

## Release notes
{notes_text[:6000]}

---

输出严格 JSON（不要 markdown code block）：

{{
  "highlights": ["每条一句话：变更主题 + Orb 可用于/需要关注的点", "..."],
  "note": "一句话总结本次升级性质（如：仅 bug fix / 含 X 新能力 / 架构级变动）"
}}

规则：
- 最多 3 条 highlights
- 一条 highlight = 一个主题（相关 commit 合并）
- 无相关变更则 highlights 输出 []，note 明确写"本次升级对 Orb 无明显相关"
"""

    try:
        r = subprocess.run(
            ['codex', 'exec', '--skip-git-repo-check', '--model', CODEX_MODEL, '-'],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if r.returncode != 0:
            return []
        out = r.stdout.strip()
        m = re.search(r'\{[\s\S]*\}', out)
        if not m:
            return []
        parsed = json.loads(m.group(0))
        return [str(x).strip() for x in (parsed.get('highlights') or []) if str(x).strip()][:3]
    except Exception:
        return []


def main():
    if len(sys.argv) < 4:
        print('[]')
        return
    tool, old_ver, new_ver = sys.argv[1], sys.argv[2], sys.argv[3]
    slug = REPO_SLUGS.get(tool)
    if not slug:
        print('[]')
        return

    old_tuple = clean_ver(old_ver)
    new_tuple = clean_ver(new_ver)
    if new_tuple <= old_tuple:
        print('[]')
        return

    try:
        releases = fetch_releases(slug)
    except Exception:
        print('[]')
        return

    picked = []
    for rel in releases:
        tag = (rel.get('tag_name') or '').strip()
        t = clean_ver(tag)
        if t == (0, 0, 0):
            continue
        if old_tuple < t <= new_tuple:
            picked.append(rel)

    if not picked:
        print('[]')
        return

    notes_text = '\n\n'.join(
        f"## {r.get('tag_name')} ({r.get('published_at','')[:10]})\n{(r.get('body') or '').strip()}"
        for r in picked
    )

    highlights = summarize_via_codex(tool, old_ver, new_ver, notes_text)
    print(json.dumps(highlights, ensure_ascii=False))


if __name__ == '__main__':
    main()
