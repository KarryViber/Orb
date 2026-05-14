---
name: session-wrap-up
description: Session 收工标准 SOP——任何路径触发「收工」（reaction ✅ / 文字「收工 / wrap up / 闭包」/ cron 自动）都走同一动作链：自测 → commit（含受保护路径 override 规则）→ 清过程产物（临时 spec / debug 输出 / dry-run 文件 / 中间 patch）→ 报 commit hash + 清理清单。Use when 用户说「收工 / 闭包 / wrap up / OK 收工 / 结束这一段」，或 ✅ reaction 触发 inject 含「收工」字样。
---

## 触发场景

满足以下任一条件即召回：

- 用户文字消息含「收工」「闭包」「wrap up」「结束这段」「就这样收尾」
- ✅ reaction 触发的 inject 文本（reaction map 中映射为「收工」）
- 多步任务自评判已经完成，主动确认是否走收工流程

## 收工动作链（按顺序）

### Step 1: 自测

- 改动涉及 src/ 或脚本：跑 `node -c <file>` / `python3 -c "import <module>"` 至少做语法校验
- 涉及测试套件：跑 `npm test` 或对应 `pytest`，确认无 regression
- 改动涉及 cron / handler：smoke 跑一次 dry-run 验证不空跑、不报错
- 改动涉及对客文档 / 交付物：lint（jp-lint 等 skill）走一遍

### Step 2: Commit

- `git status` + `git diff --cached --stat` 先审 staged 内容，**避免混 scope**（参见近期教训：单次 commit 多文件意外 staged）
- 只 `git add <明确文件>`，不用 `git add -A` 或 `git add .`
- 受保护路径（src/** / .claude/skills/** / package.json / config.json / start.sh）必须 `ORB_BOUNDARY_OVERRIDE=1 git commit ...`，stderr 留痕
- commit message 走 commit-lineage 规范（带 spec / lesson / 决策原文锚点）
- 不主动 push 到 remote（除非用户明确说 push）

### Step 3: 清过程产物

按以下分类逐项检查，命中即清：

| 类别 | 典型路径 | 处理 |
|---|---|---|
| 临时 spec | `specs/<name>.md` 已落地的 | mv 到 `specs/_archive/<YYYY-MM>/` |
| Debug 输出 | `/tmp/*.log`, `/tmp/codex-*.log`, console.log / print 调试代码 | rm tmp 文件 / git diff 检查未删除的 debug print |
| Dry-run 输出 | `*-DRYRUN.md`, `*.dry-run.json` | 命中 → 评估归档或 rm |
| 中间 patch | `*.patch`, `*.diff`, `git stash` 残留 | rm / `git stash drop` |
| 测试报告 | `audit-reports/`, `*.report.json` 临时态 | 评估归档或 rm |
| 备份文件 | `*.bak`, `*.last`, `*.legacy` sibling | **先 grep 源码确认无运行时引用**再 rm（fallback 文件常用此命名，重要！） |

### Step 4: 报告收工状态

输出格式：

```
✅ 收工
- commits: <hash1> <hash2> ...
- 自测: <跑了什么 / 结果>
- 清理: <清掉的文件清单 / 归档路径>
- 残留: <主动留下的产物 + 原因>
```

## Gotchas

- **混 scope commit**：codex / 外部 session 跑完后 `git diff --cached --stat` 必查，多文件 staged 时不要直接 commit，先审是不是别 session 留的
- **备份文件别乱删**：`.bak / .last / .legacy / .archive` 类 sibling 文件清理前必须 `grep -rn $(basename) src/`，框架级 fallback 常用此命名（参考 lesson `cleanup-bak-files-grep-first`）
- **受保护路径 commit 不要默认走 override**：先确认改动确实属于该 commit 的合理 scope，override 是显式越权不是默认通道
- **不主动 push**：收工 ≠ push，push 是用户显式动作
- **真验证 vs `exit 0`**：脚本 exit 0 不代表事情做对了，视觉/状态产物（pptx / pdf / UI）必须 thumbnail / pdftotext / 截图二次校验

## 失败处理

- 自测失败 → 不 commit，把失败信息原样报给用户，等指示
- commit hook 拒绝 → 不要 `--no-verify` 绕过，先看是不是 boundary guard 提示路径，按规则补 override
- 清理时不确定文件用途 → 跳过该项，列在残留里说明，等用户拍

## 相关 skill

- `commit-lineage`：commit message 锚点要求
- `verification-before-completion`：completion 前的证据要求
- `change-blast-radius-check`：删除 / 重命名前的全维度 grep
