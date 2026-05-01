---
name: coding-agent-workflow
description: 代码任务委派三层决策——自己做 / 本 session sub-agent（Task tool）/ 外部 Codex session（spec 文件）。Use when 任何代码/调研/重构任务开工前判断谁来做，或用户说「派个 agent」「让 codex 搞」「并行跑」。
provenance: user-authored
---

# Coding Agent 委派三层决策

## 三层分工

| 层 | 工具 | 适用 | 边界 |
|---|---|---|---|
| L0 自己做 | 直接 Read/Edit/Grep | 改 <3 文件、上下文已在手、单一逻辑 | context 预算够、不涉及 `~/Orb/src/` |
| L1 Sub-agent（本 session） | `Task` tool（Explore / general-purpose / feature-dev:* / pr-review-toolkit:*） | 护 context（大量 grep/read）、并行独立调研、专项审查 | 不能改 `~/Orb/src/`；不做 synthesis |
| L2 外部 session（Codex / CC） | `specs/xxx.md` + `external-session-spawn.sh` 派遣 | **改 Orb 源码铁律**、跨 session 隔离、大重构 (≥10 文件) | 必须先写 spec；走 launcher 自动回报，不裸跑 codex/claude |

## Trigger 判别

**→ L0 自己做**
- 改动 <3 文件 且 不碰 `~/Orb/src/`
- 只读分析 + 短回答

**→ L1 sub-agent（Task tool）**
- 需要跑 ≥3 次 grep/glob 才能定位 → `Explore`（"quick/medium/very thorough"）
- 多个独立域并行调研（同时查 Linear API + Slack manifest）→ 多个 `Task` 并发
- 写完代码让人审 → `pr-review-toolkit:code-reviewer`
- 架构设计 → `feature-dev:code-architect`

**→ L2 外部 session**
- 动 `~/Orb/src/*.js`、`package.json`、`start.sh`、`config.json`（自改会崩 + CLAUDE.md 铁律）
- 改动预估 ≥10 文件或 ≥架构级
- 需要跨 session 隔离（本 session context 已满 / 实验性改动）

## L1 触发=必须清单（硬阈值，事件驱动）

> 偷自 runesleo/claude-code-workflow v2（2026-04 CHANGELOG）。背景：他 30 天实测 agent 分派率仅 0.18%（44/24722 API calls），结论是「软建议无约束力，触发=必须才有」。Orb 同样有 skill 但偏软，本节把 L1 判别从描述升级成铁律。

**命中以下任一条件**必须**派 L1 sub-agent，不得自己硬扛**：

| 触发 | 必须分派到 | 原因 |
|---|---|---|
| Read ≥3 文件才能回答单个问题 | `Explore` (medium) | 护主 session context |
| 跨目录 Grep ≥3 轮才能定位 | `Explore` (very thorough) | 同上 |
| URL 研究 / GitHub repo 调研 / 第三方文档抓取 | `Explore` 或 `general-purpose` | 整 repo / 整文档塞主 session = 浪费 |
| ≥3 个独立域并行调研（互不依赖） | 多个 `Task` 并发 | 串行浪费时间 |
| 写完非 trivial 代码 ≥50 行 | `pr-review-toolkit:code-reviewer` | 自审有盲点 |

**强制留痕**：每次 L1 分派必须输出一句 `🔀 分派 → <agent_type>：<一句话目标>`。便于事后 grep transcript 审计漏派。

**反向铁律**：命中清单条件**未派 = 流程作弊**。事后发现写 lesson 复盘到 `~/Orb/profiles/karry/data/lessons/agent-dispatch-miss-*.md`，标记触发场景 + 漏派代价。

**例外**：
- 任务本身就是「读 1 个特定文件回答 1 个具体问题」→ L0 自己做（即使 ≥3 行 grep 也走 L0，因为目标文件已知）
- Karry 显式说「你直接干」→ 服从

## L2 内部选型：Codex vs CC

**默认 Codex**：
- 隔离干净：`codex exec` 一次性 spawn，stdout 拿回 diff 就回收，不留 session 状态
- spec-first 友好：人格就是「读 spec → 干完 → 退出」，不反问、不找 Karry 互动
- 成本低：单次性任务不挂 session

**何时改用 CC**：
- 多轮探查 + 反复试错（agentic loop 强）
- 需要复用 Orb 的 skills/CLAUDE.md 体系（CC 起在 `~/Orb/profiles/karry/workspace/` 能直接吃到全套 skill + memory，Codex 是裸的）
- 任务边界模糊、需要在歧义点停下确认

**决策树**：
```
改 Orb src/ 单文件 + spec 清晰         → Codex
改 Orb src/ 跨模块 + 需要探查          → CC（带 skill）
独立子项目（不依赖 Orb skill 体系）    → Codex
视觉/文档/agentic loop 类               → CC
```

## L1 Sub-agent prompt 模板

```
[目标]：一句话目标
[背景]：为什么做（非 synthesis，只给事实）
[范围]：可以看/改的文件或目录
[约束]：不能改什么、不能重构什么
[输出]：期望返回格式（发现清单 / 诊断 / diff 路径），字数上限
```

**反例**：`"根据你的调查来修 bug"` ← synthesis 外包了
**正例**：`"定位 src/scheduler.js 里负责 stream lifecycle 的函数，返回函数名 + 行号 + 30 字职责"`

## L2 派遣：external-session-spawn.sh（默认入口）

**默认必走 launcher**，不裸跑 `codex exec` / `claude -p`。launcher 解决两个问题：
1. 标准姿势固化（codex `--cd ~/Orb` + bypass + `</dev/null` + stderr 噪音过滤；claude `-p` + skip-permissions）
2. **自动完成回报**——后台跑完用 `chat.postMessage` 推回原 thread，不需要 Karry 催「好了吗？」

```bash
~/Orb/scripts/external-session-spawn.sh \
  --engine codex \
  --channel <slack-channel-id> \
  --thread <slack-thread-ts> \
  --label "<人类可读标签>" \
  --log /tmp/<engine>-<topic>-$(date +%s).log \
  --prompt "严格按 specs/<topic>.md 执行。只改 spec 列出的文件，不 git add/commit。完成后输出 diff 摘要。"
```

`--engine claude` 用法相同，prompt 直接是任务描述（不必引用 spec，Claude Code 会读 skills/CLAUDE.md）。

**调用方做的事**：
1. 立即拿到 launcher stdout 输出的 `pid + log + label`
2. 在 thread 回 Karry 一句「已派 X，跑完自动回报」
3. **不再用 ScheduleWakeup 猜时间**——launcher 完成后 Bot 自发的 ✅ 消息会出现在 thread

**Bot 自发消息**默认不触发新 worker（adapter 忽略 self），不会循环；Karry 看到 ✅ 后若要详细 diff/commit，主动问就好。

### 五个铁律（launcher 内部已实现，调用方了解原因即可）

1. **`--cd` 必须是 `~/Orb`**，不能给子目录。原因：codex sandbox 把 `--cd` 当可写根，给 `workspace/` 会让 `~/Orb/profiles/karry/scripts/` 被踢出可写域，4/30 daily-notes-monitor regex 修复就栽在这。
2. **`</dev/null` 强制关 stdin** — codex 检测到 stdin open 会等输入，heredoc/pipe 喂 prompt 都会触发挂起
3. **prompt 走位置参数**，不走 heredoc / pipe / `<<EOF`
4. **`--dangerously-bypass-approvals-and-sandbox`** + **spec 里禁止 codex 动 git** — 既绕开 sandbox 拦 `.git/index.lock`，又保证 diff 由主 session commit、日志不乱
5. **stderr 过滤 `failed to record rollout items: thread`** — codex_core 内部 rollout 持久化噪音，每次 exec 都出现且不影响执行

### 调用反例速查

| 写法 | 踩的坑 |
|---|---|
| 裸跑 `codex exec ...` 不走 launcher | ⚠️ 没自动回报，要 Karry 催「好了吗」 |
| `codex exec --cd ~/Orb/profiles/karry/workspace ...` | ① sandbox 把 workspace 当可写根，profiles/karry/scripts 被踢出 |
| `echo "干活" \| codex exec ...` | ② stdin 管道，挂 |
| `codex exec <<EOF ... EOF` | ② heredoc，同样挂 |
| `codex exec --sandbox workspace-write "...动 .git..."` | ③ sandbox 拦 `.git/index.lock` |
| 不加 `--cd`，cwd 飘 | 改错文件 |
| spec 里写「commit 一下」 | codex 边写边 commit，主 session diff 回收混乱 |
| 不过滤 stderr | rollout ERROR 每次出现，混淆真错误 |

> **强制**：`~/Orb/profiles/karry/workspace/.claude/hooks/codex-exec-guard.sh` 已升级为 block 模式（PreToolUse Bash hook，`exit 2` 阻断）。命中铁律 1-4 任一坑会被直接拦下。launcher 内部已经合规，所以裸调用 launcher 不被 block；如果绕过 launcher 自己写 codex exec 命令，hook 还在守底线。

### 何时仍可裸跑（罕见例外）

只在以下场景手动调用 codex exec / claude -p（不走 launcher）：
- 一次性命令行测试 / 调试 launcher 自身
- 不需要 Slack 回报的本地探查（短任务 < 30s）
- 没有 thread 上下文（cron 等已经有自己的失败回报机制）

例外场景仍然受 hook 管制，必须用标准模板。

## L2 外部 Codex spec 模板

放 `~/Orb/specs/<topic>.md`：

```markdown
# <Topic>

## 目标
<一句话>

## 背景 / 根因
<为什么改，指向具体 bug/需求>

## 相关上下文位置
<外部 codex 不知道 Orb 有这些索引，显式告诉它去哪找；没有则写「无」>
- 对话记忆：holographic DB（`profiles/karry/data/memory.db`），trust>0.6 相关 facts
- 文件知识：docstore FTS（`profiles/karry/data/doc-index.db`，slug: <project-slug>）
- spec 前置 / 历史 spec：`specs/<related>.md`
- 运行时日志：`logs/orb.log`

## 变更范围
- 可改：src/scheduler.js (L120-180), src/worker.js (IPC handler)
- 禁改：adapters/*, lib/holographic/*, config.json

## 禁写区（默认值，每个 spec 必带）
codex 验收 / 自测期间禁止写以下生产数据，要造数据用临时 fixture：
- `profiles/karry/data/memory.db`（holographic 记忆，曾被 codex 验收时塞测试 fact）
- `profiles/karry/data/cron-jobs.json`（活 cron，写错会乱 schedule）
- `profiles/karry/data/sessions.json`（thread↔session 映射）
- `profiles/karry/data/doc-index.db`（DocStore FTS）
- `profiles/karry/data/daily-notes/*.md`（实时日记）
- 任何 `profiles/*/data/` 下的真实落盘文件

例外（spec 显式声明才能写）：
- 测试数据 fixture：写 `/tmp/` 或 spec 指定的 `tests/fixtures/`
- 本 spec 改动需要新增的产物：spec 显式写明路径

## 执行边界（硬约束，codex 必须遵守）
- 只改本文件「变更范围」列出的路径
- 不写「禁写区」列出的路径
- 不执行 `git add` / `git commit` / `git push`
- 完成后输出 diff 摘要，由主 session 回收并 commit

## 设计要点
1. ...
2. ...

## 验收
- [ ] 单测 `npm test -- scheduler` 全绿
- [ ] 手动：发 /xxx 到 #test-channel，thread 内流式正常
- [ ] git diff 行数 < 300
- [ ] 不引入新依赖
- [ ] 禁写区文件未被改动（`git status` 不应出现 data/*.db / data/*.json）

## 执行
调研 turn ≤ X，实施 turn ≤ Y。
```

## 验证回收协议

收到 launcher 自动 ✅ 后：

1. **读 diff / 读 log**，不信任 launcher 摘要（"agent 说做了 X 不等于做了 X"）
2. **验禁写区**：`git status` + `ls -la profiles/karry/data/*.db profiles/karry/data/*.json` 看 mtime，禁写文件被改 = FAIL，回滚 + 改 spec 重派
3. 判级：
   - **PASS** — 符合预期，commit
   - **PARTIAL** — 列缺口，决定本地补 or 再派一轮
   - **FAIL** — 分析原因（spec 不清 / context 不够 / 方向错），改 spec 重派，不手工救火
4. **架构级改动**（L2）commit 后追加 daily-note 一行

收到 launcher ❌ 时：直接看 log tail（消息附带前 800 字符），多数情况 spec 不清或 sandbox 误判，看清根因后改 spec 重派，不手工救火。

## 禁区

- ❌ **禁止派 sub-agent（L1）改 `~/Orb/src/`** — sub-agent 没 Orb 铁律感知，会直接改；L2 codex 才能改
- ❌ **禁止 L1 + L2 嵌套**（sub-agent 再派 codex）— 失控
- ❌ **禁止裸跑 codex exec / claude -p**（除少数例外）— 没自动回报，会重蹈「好了吗？」覆辙
- ❌ **禁止把"理解"外包** — Orb 自己必须看 diff、读回报、做判断，不写 "agent 说 OK 就 OK"
- ❌ **禁止 spec 用 "根据你的判断" / "看情况办"** — 外部 codex 没 context，要具体到文件行号

## 与 `subagent-driven-development` 的关系

全局 skill `subagent-driven-development` 是通用 plan→dispatch→review 流水线（superpowers 版）。本 skill 补 Orb 特化层：**何时用 L1 vs L2 + Orb 禁改自身源码的铁律 + launcher 自动回报姿势**。执行大 plan 时两个 skill 叠用——本 skill 先定位「这步该 L1 还是 L2」，大 plan 迭代时套 `subagent-driven-development` 的 batch + review 模式。
