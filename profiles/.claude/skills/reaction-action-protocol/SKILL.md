---
name: reaction-action-protocol
description: Reaction quick-reply 信号统一协议——✅/👉/🚀/🔄/✋/👀 六个 reaction（以及对应文字打「收工 / 继续 / 派吧 / 换条思路 / 先停一下 / 展开看看」）触发后的语义解读 + 动作链。✅ 收工含完整 SOP（自测 → commit → 清过程产物 → 报告）。Use when reaction inject 触发 / 用户文字命中其中关键词 / 多步任务自评估走收尾 / cron 自动 wrap-up。🔥 rerun 不在此 skill 范围（adapter 硬编码）。
---

## 触发机制

对 bot 消息（Orb 最后一条回复）打 reaction，等价于在 thread 发同名文字指令——adapter 自动转 inject 注入 worker：

| Reaction | Slack name | 等价文字 |
|---|---|---|
| ✅ | `white_check_mark` | 收工 |
| 👉 | `point_right` | 继续 |
| 🚀 | `rocket` | 派吧，干 |
| 🔄 | `arrows_counterclockwise` | 换条思路 |
| ✋ | `hand` | 先停一下 |
| 👀 | `eyes` | 展开看看 |
| 🔥 | `fire` | rerun（effort:xhigh，单独路径） |

对**非 bot 消息**的 reaction 被静默忽略；同一 reaction 30s 内去重。

## 触发场景

任意以下条件命中即召回：

- ✅/👉/🚀/🔄/✋/👀 reaction 触发的 inject 文本
- 用户文字消息含「收工 / 闭包 / wrap up / 继续 / 派吧 / 干 / 全做 / 换条思路 / 换方向 / 先停 / 等等 / 展开看看 / 细看」
- 多步任务自评估完成时主动确认走哪条信号
- cron 自动 wrap-up 流程

## 信号 → 动作

### ✅ 「收工」— 完整 SOP

**Step 1: 自测**
- 改动涉及 src/ 或脚本：跑 `node -c <file>` / `python3 -c "import <module>"` 至少做语法校验
- 涉及测试套件：跑 `npm test` 或对应 `pytest`，确认无 regression
- 改动涉及 cron / handler：smoke 跑一次 dry-run 验证不空跑、不报错
- 改动涉及对客文档 / 交付物：lint（jp-lint 等 skill）走一遍

**Step 2: Commit**
- `git status` + `git diff --cached --stat` 先审 staged 内容，**避免混 scope**
- 只 `git add <明确文件>`，不用 `git add -A` 或 `git add .`
- 受保护路径（src/** / .claude/skills/** / package.json / config.json / start.sh）必须 `ORB_BOUNDARY_OVERRIDE=1 git commit ...`
- commit message 走 commit-lineage 规范（带 spec / lesson / 决策原文锚点）
- 不主动 push 到 remote

**Step 3: 清过程产物**

| 类别 | 典型路径 | 处理 |
|---|---|---|
| 临时 spec | `specs/<name>.md` 已落地的 | mv 到 `specs/_archive/<YYYY-MM>/` |
| Debug 输出 | `/tmp/*.log`, console.log / print 调试代码 | rm tmp 文件 / git diff 检查未删 debug print |
| Dry-run 输出 | `*-DRYRUN.md`, `*.dry-run.json` | 评估归档或 rm |
| 中间 patch | `*.patch`, `*.diff`, `git stash` 残留 | rm / `git stash drop` |
| 测试报告 | `audit-reports/`, `*.report.json` 临时态 | 评估归档或 rm |
| 备份文件 | `*.bak`, `*.last`, `*.legacy` sibling | **先 grep 源码确认无运行时引用**再 rm |

**Step 4: 报告**
```
✅ 收工
- commits: <hash1> <hash2> ...
- 自测: <跑了什么 / 结果>
- 清理: <清掉的文件清单 / 归档路径>
- 残留: <主动留下的产物 + 原因>
```

### 👉 「继续」— 推进信号

- 默认推进到 worker 上一句明示 / 暗示的「下一步」
- 上下文存在 ≥2 个候选下一步且无明显默认时，**简短一句**问清，不要列长选项
- 不重新规划，不扩展任务范围

### 🚀 「派吧 / 干」— 批量放权信号

- 命中 askuserquestion-triggers 的批量放权关键词，触发 done 标准前置 AUQ
- done 标准已显式给出（包括上下文中已对齐）→ 直接派 codex / 起 spec / 批量执行
- done 标准歧义 → 主动 AUQ 推 2-3 个候选 done 标准，等 Karry 一键点选再动
- 派 codex 时 spec 必含 `## 执行` 段标 turn 预算（详见执行纪律）

### 🔄 「换条思路」— 框架级重审

- 不是调参——重新审框架/方案
- 先 SOTU 当前判断的 3 个隐含假设，再换思路
- 给 ≥2 个新候选方向，不是只翻面一个

### ✋ 「先停一下」— 暂停信号

- 立刻停手，不再推进任何动作
- 用 scratchpad-append.py 记当前状态：已做 / 待做 / 卡点 / 关键中间结论
- 等 Karry 指示，不主动猜下一步

### 👀 「展开看看」— 细节展开

- 出当前最近一段的细节 / 证据 / 反例
- 聚焦 Karry 当前关注的 1-2 个点，不要把所有信息倾倒
- 已展开过的内容不重复

### 🔥 rerun — 不在此 skill 范围

- 行为已硬编码在 adapter（强制 fork + effort:xhigh）
- 不召回此 skill，纯 worker 复跑

## Gotchas

- **混 scope commit**：codex / 外部 session 跑完后 `git diff --cached --stat` 必查，多文件 staged 时不要直接 commit
- **备份文件别乱删**：`.bak / .last / .legacy / .archive` 类 sibling 文件清理前必须 `grep -rn $(basename) src/`，框架级 fallback 常用此命名
- **受保护路径 commit 不要默认走 override**：先确认改动属于该 commit 合理 scope
- **不主动 push**：收工 ≠ push，push 是用户显式动作
- **真验证 vs `exit 0`**：脚本 exit 0 ≠ 事情做对了，视觉/状态产物（pptx / pdf / UI）必须 thumbnail / pdftotext / 截图二次校验
- **「派吧」不等于「不用确认」**：done 标准歧义时仍要 AUQ 前置，零打字 ack 不是绕过对齐

## 失败处理

- 自测失败 → 不 commit，把失败信息原样报，等指示
- commit hook 拒绝 → 不要 `--no-verify` 绕过，看是不是 boundary guard，按规则补 override
- 清理时不确定文件用途 → 跳过该项，列在残留里说明，等用户拍

## 相关 skill

- `commit-lineage`：commit message 锚点要求
- `verification-before-completion`：completion 前的证据要求
- `change-blast-radius-check`：删除 / 重命名前的全维度 grep
- `askuserquestion-triggers`：🚀 派吧的 done 标准 AUQ 触发条件
