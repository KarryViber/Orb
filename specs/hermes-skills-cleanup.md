# Spec: Hermes Skills 路径清理

## 背景

Hermes 已退租（`~/.hermes/` 已删除）。此前批量 `cp -r` 把 71 个 skill 从 `~/.hermes/skills/` 复制到 `~/.claude/skills/`，但 skill 内部仍有大量 `~/.hermes/` 硬编码引用。现需批量替换为 Orb 对应路径，使 skill 可直接调用。

**`godmode` 和 `diagram-router` 两个 skill 已被删除**（它们有深度 `~/.hermes/` 依赖且有替代品）。

## 目标

清理 `~/.claude/skills/` 下所有 `~/.hermes/` 残留引用，映射到 Orb 真实路径。

## 映射规则

| Hermes 原路径 | Orb 目标路径 |
|--------------|--------------|
| `~/.hermes/.env` | `~/Orb/.env` |
| `/Users/karry/.hermes/scripts/` | `/Users/karry/Orb/profiles/karry/scripts/` |
| `~/.hermes/scripts/` | `~/Orb/profiles/karry/scripts/` |
| `~/.hermes/skills/github/github-auth/scripts/gh-env.sh` | `~/.claude/skills/github-auth/scripts/gh-env.sh` |
| `${HERMES_HOME:-$HOME/.hermes}` | `$HOME/Orb` |
| `Path.home() / ".hermes"` | `Path.home() / "Orb"` |
| `os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))` | `os.environ.get("HERMES_HOME", str(Path.home() / "Orb"))` |

## 执行步骤

```bash
cd ~/.claude/skills

# 1. github token fallback: ~/.hermes/.env → ~/Orb/.env
find . -type f \( -name "*.md" -o -name "*.sh" -o -name "*.py" \) \
  -exec sed -i '' 's|~/\.hermes/\.env|~/Orb/.env|g' {} +

# 2. finance scripts 绝对路径
find . -type f \( -name "*.md" -o -name "*.sh" -o -name "*.py" \) \
  -exec sed -i '' 's|/Users/karry/\.hermes/scripts/|/Users/karry/Orb/profiles/karry/scripts/|g' {} +

# 3. finance scripts tilde 版本
find . -type f \( -name "*.md" -o -name "*.sh" -o -name "*.py" \) \
  -exec sed -i '' 's|~/\.hermes/scripts/|~/Orb/profiles/karry/scripts/|g' {} +

# 4. github-auth 脚本路径（指向 Layer 2 新位置）
find . -type f \( -name "*.md" -o -name "*.sh" -o -name "*.py" \) \
  -exec sed -i '' 's|~/\.hermes/skills/github/github-auth/scripts/gh-env\.sh|~/.claude/skills/github-auth/scripts/gh-env.sh|g' {} +

# 5. HERMES_HOME shell 默认值
find . -type f \( -name "*.md" -o -name "*.sh" -o -name "*.py" \) \
  -exec sed -i '' 's|HERMES_HOME:-\$HOME/\.hermes|HERMES_HOME:-$HOME/Orb|g' {} +

# 6. HERMES_HOME Python 默认值
find . -type f -name "*.py" \
  -exec sed -i '' 's|Path.home() / ".hermes"|Path.home() / "Orb"|g' {} +

# 7. 验证清理结果
grep -rn '\.hermes' .
```

## 验收标准

执行完第 7 步后，剩余的 `~/.hermes/` 引用应仅限以下 **无害类**（可保留）：

1. `~/.hermes/config.yaml` 引用 — Orb 无此文件，skill 本身在 Orb 上不完全适用（`native-mcp`、`llm-wiki`）。后续若要启用，需要让 skill 改读别的位置，但此 spec 不处理。
2. `~/.hermes/dyna-bot/user_token.json` 引用 — 仅在 `local-chrome-automation` 的文档里作为"过期失败示例"出现，不影响执行。
3. `.hermes/plans/` 单次文档提及（`research-paper-writing` 某段表格）— 无副作用。

**预期输出**：`grep` 结果不超过约 10 行，全部属于上述 3 类。

## 可选后续（不在本 spec 范围）

- `native-mcp` / `llm-wiki` 若需要在 Orb 下启用，把 `~/.hermes/config.yaml` 改成 `~/Orb/config.json` 或在 Orb 添加对应的 skill config 机制（需架构级讨论）
- Skill frontmatter 里 Hermes 专属字段（`version`、`author`、`metadata.hermes.tags` 等）54 个文件有遗留，Claude Code 能容忍，但可以后续批量清理成纯净 `name + description` 格式

## 运行环境

- **工作目录**：`~/.claude/skills/`
- **需权限**：写 `~/.claude/skills/` 下所有文件
- **无副作用扩散**：不触及 Orb 主仓代码、不动 Orb daemon

## 完成后报告

- 执行完各步骤的摘要（每步有无修改、修改了多少文件）
- 最后 `grep` 的完整输出（截图或文本）
- 是否有任何非预期的剩余引用（如果超出"无害类"清单）
