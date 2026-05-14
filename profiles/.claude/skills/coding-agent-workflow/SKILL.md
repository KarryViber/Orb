---
name: coding-agent-workflow
description: 代码任务委派三层决策——自己做 / 本 session sub-agent（Task tool）/ 外部 Codex session（spec 文件）。Use when 任何代码/调研/重构任务开工前判断谁来做，或用户说「派个 agent」「让 codex 搞」「并行跑」。
---

# Coding Agent 委派三层决策

## 三层分工

| 层 | 工具 | 适用 | 边界 |
|---|---|---|-------|
| L0 自己做 | 直接 Read/Edit/Grep | 改 <3 文件、上下文已在手、单一逻辑 | context 预算够、不涉及 `~/Orb/src/` |
| L1 Sub-agent（本 session） | `Task` tool（Explore / general-purpose / feature-dev:* / pr-review-toolkit:*） | 护 context（大量 grep/read）、并行独立调研、专项审查 | 不能改 `~/Orb/src/`；不做 synthesis |
| L2 外部 session（Codex / CC） | `specs/xxx.md` + `external-session-spawn.sh` 派遣 | **改 Orb 源码铁律**、跨 session 隔离、大重构 (≥10 文件)、**长程 audit / 治理（worker timeout 风险）** | 必须先写 spec；走 launcher 自动回报，不裸跑 codex/claude |

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
- **长程 audit / 大型治理任务**（预估 worker turn 跨度 >30min 或多次 turn）— 见下节专门规则

## 长程 audit / 大型治理：默认 codex 化（体制铁律）

**症状识别**：任何「全面审计 / 整体治理 / 跨多个子系统的 cleanup / 重大 refactor」类任务，**默认走 L2 codex 化**，主 thread 只做 dispatch + 回报。

**为什么不能挂在主 worker 跑**：

1. **Worker timeout** = `ORB_WORKER_TIMEOUT_MS` 默认 30min，长程任务必然超时。worker 死 → task card 卡半截 + 用户什么都看不到（即使 task-card-interrupt-recovery 已 ship 中断红条 + sticky snapshot，那只是降级显示，进度本身丢了）。
2. **Slack stream 是 per-turn-per-message 设计**（lessons/slack-stream-chunk-semantics.md）：跨 turn `inject` 必新建 stream，原 task card 不延续。Karry 看到的进度被切碎到多个独立卡。
3. **Context 中段衰减 30%+**（agent harness 文献）：长 prompt 中段信息容易被忽略，长程任务在主 worker 反而比 codex 单跑次数多 + 错。

**正确姿势**：

```
长程任务到来
  ↓
主 thread 写 spec → external-session-spawn.sh --engine codex --spec <path>
  ↓
立即拿到 pid / log，主 thread 回 Karry 一句「已派，跑完自动回报」
  ↓
codex 后台独立跑（不受主 worker timeout 影响）
  ↓
跑完自动 chat.postMessage ✅ 推回原 thread
  ↓
主 session 验真 + commit + 归档
```

**实证（2026-05-08）**：Orb 全面审计治理 thread。原始一锅塞主 worker 跑：第一轮 30min timeout 中途挂，task card 显示半截进度，必须发「继续」重启。改成 spec + 串行 codex 派遣后（fork-A `orb-fork-a-cleanup-2026-05-08.md` / fork-A 余项 `orb-fork-a-safe-2026-05-08.md` / `task-card-interrupt-recovery-2026-05-08.md` 等），每个 codex 独立跑完自动回报，主 worker 可任意 idle/重启，进度永不丢。

**反例**：

| 误用场景 | 后果 |
|---|---|
| Karry 说「全面审计 X 系统」直接在主 thread 自己干 | 30min 后 timeout，task card 半截 |
| 「重构 5 个模块」全塞 TodoWrite + 自己执行 | turn 跨度太长，stream 切碎多卡 |
| 「调研 10 个第三方库 + 写报告」自己读 | context 衰减 + 调研结果稀释主结论 |

**正解**：上述场景**第一动作**是写 spec → 派 codex；主 thread 只做选型 + 回报判断。

**例外**（仍可主 worker 跑）：
- 任务本身 <30min 可见完结
- 用户显式「你直接干，不要派 codex」
- 紧急修复必须立即出结果（codex 派遣 + 等回报 ≥ 2min 启动开销）

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

**反向铁律**：命中清单条件**未派 = 流程作弊**。事后发现写 lesson 复盘到 `~/Orb/profiles/<your-profile>/data/lessons/agent-dispatch-miss-*.md`，标记触发场景 + 漏派代价。

**例外**：
- 任务本身就是「读 1 个特定文件回答 1 个具体问题」→ L0 自己做（即使 ≥3 行 grep 也走 L0，因为目标文件已知）
- Karry 显式说「你直接干」→ 服从

## L2 内部选型：Codex vs CC（铁律：默认 Codex，切 CC 必须声明）

**L2 派遣默认 `--engine codex`，无需理由，直接用。**

**切换到 CC 必须命中以下条件之一，且分派前输出一句 `🔀 CC 理由：<原因>`**：

| 切 CC 的条件 | 原因 |
|---|---|
| 任务需要多轮探查 + 反复试错，spec 无法预写完整 | Codex 一次性 exit，探查型任务需要 agentic loop |
| 必须复用 Orb 的 skills/CLAUDE.md 体系 | CC 起在 workspace/ 能直接吃 skill + memory，Codex 是裸的 |
| 任务边界模糊，需要在歧义点停下确认 | Codex 不反问，边界模糊时会猜错方向 |

**未声明理由直接选 CC = 流程违规**，事后发现写 lesson 复盘。

**决策流**（举证责任在 CC 一侧，不在 Codex 一侧）：
```
有 CC 条件？
  ├─ 是 → 输出「🔀 CC 理由：xxx」→ --engine claude
  └─ 否 → --engine codex（无需声明）
```

**对照参考**（参考，不是规则；规则是上面的 CC 条件表）：
```
改 Orb src/ 单文件 + spec 清晰         → Codex
改 Orb src/ 跨模块 + 需要探查          → CC（命中条件①）
独立子项目（不依赖 Orb skill 体系）    → Codex
视觉/文档/agentic loop 类               → CC（命中条件①②）
长程 audit / 多模块治理                → Codex
```

**为什么这样加固**：默认 Sonnet 环境下，无硬约束的「软建议」会导致 CC 的选用频率远超预期。铁律 = 举证责任在 CC 一侧，不在 Codex 一侧。

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

> **执行铁律**：决定走 L2 后，第一个 Bash 命令必须是 `external-session-spawn.sh`。
> **禁止**先尝试 `codex exec` / `claude -p` 再转 launcher——这是最常见的错误路径，会浪费 2 步且被 hook 拦下。
> **禁止传 `--model` / `-m` 给 codex**——不指定模型，让 codex 自己判断。
> 直接跳到 launcher 命令；hook 会在裸跑时 block 并提示，但那是防守线不是工作流程。

**默认必走 launcher**，不裸跑 `codex exec` / `claude -p`。launcher 解决两个问题：
1. 标准姿势固化（codex `--cd ~/Orb` + bypass + `</dev/null` + stderr 噪音过滤；claude `-p` + skip-permissions）
2. **自动完成回报**——后台跑完用 `chat.postMessage` 推回原 thread，不需要 Karry 催「好了吗？」

```bash
~/Orb/scripts/workflow/external-session-spawn.sh \
  --engine codex \
  --channel <slack-channel-id> \
  --thread <slack-thread-ts> \
  --label "<人类可读标签>" \
  --log /tmp/<engine>-<topic>-$(date +%s).log \
  --prompt "严格按 specs/<topic>.md 执行。只改 spec 列出的文件,不 git add/commit。完成后输出 diff 摘要。"
```

`--engine claude` 用法相同，prompt 直接是任务描述（不必引用 spec，Claude Code 会读 skills/CLAUDE.md）。

**调用方做的事**：
1. 立即拿到 launcher stdout 输出的 `pid + log + label`
2. 在 thread 回 Karry 一句「已派 X，跑完自动回报」
3. **不再用 ScheduleWakeup 猜时间**——launcher 完成后 Bot 自发的 ✅ 消息会出现在 thread

**Bot 自发消息**默认不触发新 worker（adapter 忽略 self），不会循环；Karry 看到 ✅ 后若要详细 diff/commit，主动问就好。

### 五个铁律（launcher 内部已实现，调用方了解原因即可）

1. **`--cd` 必须是 `~/Orb`**，不能给子目录。原因：codex sandbox 把 `--cd` 当可写根，给 `workspace/` 会让 `~/Orb/profiles/<your-profile>/scripts/` 被踢出可写域，4/30 daily-notes-monitor regex 修复就栽在这。
2. **`</dev/null` 强制关 stdin** — codex 检测到 stdin open 会等输入，heredoc/pipe 喂 prompt 都会触发挂起
3. **prompt 走位置参数**，不走 heredoc / pipe / `<<EOF`
4. **`--sandbox workspace-write` + `-c approval_policy='"never"'` + `-c sandbox_workspace_write.network_access=true`** + **spec 里禁止 codex 动 git** — 替代旧 `--dangerously-bypass-approvals-and-sandbox`（5/2 切换）。新姿势：~/Orb 顶层 + /tmp + $TMPDIR + ~/.codex/memories 在 sandbox 内可写，网络启用，approval 不阻塞；写域外（如 Karry 别处文件）会被拒，比 bypass 多一层护栏。git diff 仍由主 session commit。
5. **stderr 过滤 `failed to record rollout items: thread`** — codex_core 内部 rollout 持久化噪音，每次 exec 都出现且不影响执行

### 调用反例速查

| 写法 | 踩的坑 |
|---|---|
| 裸跑 `codex exec ...` 不走 launcher | ⚠️ 没自动回报，要 Karry 催「好了吗」 |
| `codex exec --cd ~/Orb/profiles/<your-profile>/workspace ...` | ① sandbox 把 workspace 当可写根，profiles/<your-profile>/scripts 被踢出 |
| `echo "干活" \| codex exec ...` | ② stdin 管道，挂 |
| `codex exec <<EOF ... EOF` | ② heredoc，同样挂 |
| `codex exec --sandbox workspace-write "...动 .git..."` | ③ sandbox 拦 `.git/index.lock` |
| 不加 `--cd`，cwd 飘 | 改错文件 |
| spec 里写「commit 一下」 | codex 边写边 commit，主 session diff 回收混乱 |
| 不过滤 stderr | rollout ERROR 每次出现，混淆真错误 |

> **强制**：`~/Orb/profiles/<your-profile>/workspace/.claude/hooks/codex-exec-guard.sh` 已升级为 block 模式（PreToolUse Bash hook，`exit 2` 阻断）。命中铁律 1-4 任一坑会被直接拦下。launcher 内部已经合规，所以裸调用 launcher 不被 block；如果绕过 launcher 自己写 codex exec 命令，hook 还在守底线。

### 何时仍可裸跑（罕见例外）

只在以下场景手动调用 codex exec / claude -p（不走 launcher）：
- 一次性命令行测试 / 调试 launcher 自身
- 不需要 Slack 回报的本地探查（短任务 < 30s）
- 没有 thread 上下文（cron 等已经有自己的失败回报机制）

例外场景仍然受 hook 管制，必须用标准模板。

## L2 spec 模式：自动测试 + commit + 归档 + 串联

加 `--spec <path>` 参数即触发后置流水线（2026-05-07 引入）。**codex 与 claude engine 都生效**，行为一致。

```bash
~/Orb/scripts/workflow/external-session-spawn.sh \
  --engine codex \   # 或 claude
  --channel <id> --thread <ts> --label "..." --log /tmp/... \
  --prompt "严格按 specs/<topic>.md 执行..." \
  --spec ~/Orb/profiles/<your-profile>/workspace/specs/<topic>.md
```

### 行为分工

| 谁干 | 干什么 |
|---|---|
| **session 内部（codex / claude 都一样）** | 跑 spec `## 验收` 段所有测试命令；删自己在 /tmp 创建的中间产物；删自己产生的 untracked 调试文件；**不动 git** |
| **launcher（rc=0 后内联 bash）** | `git mv spec → specs/.archive/<basename>-<YYYY-MM-DD>.md` → `git add -A && git commit -m "codex: <spec title>"` → 解析 `next_spec` 串下一份 |

launcher 的 prompt 注入前缀（自动 prepend，不需要写进 spec，两 engine 都注入）：

> 完成主任务后、退出前必须依次：①跑 `## 验收` 测试，全绿才继续；②删 /tmp 中间产物；③删 untracked 调试文件；④不动 git。

**engine 差异**：claude 已有 CLAUDE.md + `verification-before-completion` 等 skill 体系覆盖类似纪律，prompt prefix 与之冗余而不冲突；codex 是裸的，prefix 是其唯一约束源。两边的 launcher 后置（commit + 归档 + 串联）完全一致。

### Frontmatter（spec 顶层 YAML）

只有一个可选字段：

```yaml
---
next_spec: specs/step2.md   # 可选，相对 ~/Orb/profiles/<your-profile>/workspace/ 或绝对路径
---

# <Spec 标题>
...
```

无 frontmatter / 无 `next_spec` = 单步任务，跑完归档 commit 即结束。

### 多步串联

`next_spec` 在 launcher commit 完成后被 fork 起一个新的 launcher 进程（同 channel/thread），label 自动加 `→ next:<basename>`，递归同行为。**串联自动跟随上游 engine**——上游 codex 串 codex，上游 claude 串 claude，无需手动指定。

任一步测试挂 → session exit ≠ 0 → 走原 ❌ 分支，spec **保留原位不归档不 commit不串联**，链终止，failure 推 Slack 兜底。

### 适用场景

- ✅ 单步独立任务（最常见）—— 跑完自动归档 commit
- ✅ 多步串联（A 完成 + 测试通过 → B 自动起）—— 在 spec A frontmatter 写 `next_spec: specs/B.md`
- ✅ 长程 audit / 大型治理（多 fork 拆分各自 spec，串联或独派）
- ❌ 需要主 session 介入的多步（中间要 Karry 决策 / 看 diff）—— 不要串，分次手动派

### Spec `## 验收` 段写法（决定 session 跑什么测）

`## 验收` 段下的命令行/检查项是 session 自检的依据。写得越具体，session 自跑越准：

```markdown
## 验收
- [ ] 单测：`cd ~/Orb && npm test -- scheduler`
- [ ] lint：`cd ~/Orb && npm run lint`
- [ ] 手动验证（session 跳过此项，由主 session 后置）：发 /xxx 到 #test
- [ ] git diff 行数 < 300
```

session 会跑能跑的命令（前两个），跳过纯人工项，全绿才退出 0。

## L2 外部 Codex spec 模板

放 `~/Orb/specs/<topic>.md`：

```markdown
---
next_spec: specs/<next-topic>.md   # 可选；多步任务才填
---

# <Topic>

## 目标
<一句话>

## 背景 / 根因
<为什么改，指向具体 bug/需求>

## 相关上下文位置
<外部 codex 不知道 Orb 有这些索引，显式告诉它去哪找；没有则写「无」>
- 对话记忆：holographic DB（`profiles/<your-profile>/data/memory.db`），trust>0.6 相关 facts
- 文件知识：docstore FTS（`profiles/<your-profile>/data/doc-index.db`，slug: <project-slug>）
- spec 前置 / 历史 spec：`specs/<related>.md`
- 运行时日志：`logs/orb.log`

## 变更范围
- 可改：src/scheduler.js (L120-180), src/worker.js (IPC handler)
- 禁改：adapters/*, lib/holographic/*, config.json

## 禁写区（默认值，每个 spec 必带）
codex 验收 / 自测期间禁止写以下生产数据，要造数据用临时 fixture：
- `profiles/<your-profile>/data/memory.db`（holographic 记忆，曾被 codex 验收时塞测试 fact）
- `profiles/<your-profile>/data/cron-jobs.json`（活 cron，写错会乱 schedule）
- `profiles/<your-profile>/data/sessions.json`（thread↔session 映射）
- `profiles/<your-profile>/data/doc-index.db`（DocStore FTS）
- `profiles/<your-profile>/data/daily-notes/*.md`（实时日记）
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

## 收口协议

**每个 spec 执行 session 的降落规则（适用于 CC engine；Codex 单次 exit 不适用）：**

| 触发信号 | 动作 |
|---|---|
| 每完成一个主要阶段（研究/设计/实施/验收任一阶段边界） | 调 `scratchpad-append.py --kind decision` 写阶段快照：已完成/卡点/下一步 |
| 同一工具连续调用 ≥3 次且无明显进展 | 视为卡住：立即写 scratchpad checkpoint → 向 Karry 报告中断点 → 停止执行 |
| 感知到即将跑满 turns（context 压缩已发生 / 同一文件反复读 / 同一工具出现 3+ 次） | 主动降落：写 checkpoint + 报告 + 停止；不硬撑到 maxTurns 被动 stop |

**scratchpad 快照格式**：

```bash
python3 ~/Orb/profiles/<your-profile>/scripts/scratchpad-append.py \
  --thread-ts <thread_ts> \
  --kind decision \
  --title "已完成：X；卡点：Y；下一步：Z" \
  --body-file /tmp/checkpoint.md
```

**为什么**：maxTurns 跑满后 CLI 直接 stop，没有收口窗口。主动降落让 Karry 知道断点在哪，下次可以接续而不是重来。Orb 未来会在 `context.js` 注入 remaining turns 信号（spec: `orb-remaining-turns-inject-2026-05-13.md`），届时可机械感知阈值，目前靠 session 自律。

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
2. **验禁写区**：`git status` + `ls -la profiles/<your-profile>/data/*.db profiles/<your-profile>/data/*.json` 看 mtime，禁写文件被改 = FAIL，回滚 + 改 spec 重派
3. 判级：
   - **PASS** — 符合预期，commit
   - **PARTIAL** — 列缺口，决定本地补 or 再派一轮
   - **FAIL** — 分析原因（spec 不清 / context 不够 / 方向错），改 spec 重派，不手工救火
4. **架构级改动**（L2）commit 后追加 daily-note 一行

收到 launcher ❌ 时：直接看 log tail（消息附带前 800 字符），多数情况 spec 不清或 sandbox 误判，看清根因后改 spec 重派，不手工救火。

**spec 模式特别注意**：launcher 已自动 commit + 归档，回收协议第 1-2 步仍要做（验真）；如果 commit 内容超出 spec 范围或有禁写区污染，用 `git revert <hash>` 回滚而非 reset（commit 已落盘）。

## 禁区

- ❌ **禁止派 sub-agent（L1）改 `~/Orb/src/`** — sub-agent 没 Orb 铁律感知，会直接改；L2 codex 才能改
- ❌ **禁止 L1 + L2 嵌套**（sub-agent 再派 codex）— 失控
- ❌ **禁止裸跑 codex exec / claude -p**（除少数例外）— 没自动回报，会重蹈「好了吗？」覆辙
- ❌ **禁止把"理解"外包** — Orb 自己必须看 diff、读回报、做判断，不写 "agent 说 OK 就 OK"
- ❌ **禁止 spec 用 "根据你的判断" / "看情况办"** — 外部 codex 没 context，要具体到文件行号
- ❌ **禁止长程 audit / 多模块治理在主 worker 跑** — 必走 L2 codex 化（见上节），主 worker 30min timeout 必死
- ❌ **禁止未声明理由选 CC** — L2 默认 Codex；切 CC 必须输出 `🔀 CC 理由：xxx`，无理由 = 流程违规

## 与 `subagent-driven-development` 的关系

全局 skill `subagent-driven-development` 是通用 plan→dispatch→review 流水线（superpowers 版）。本 skill 补 Orb 特化层：**何时用 L1 vs L2 + Orb 禁改自身源码的铁律 + launcher 自动回报姿势**。执行大 plan 时两个 skill 叠用——本 skill 先定位「这步该 L1 还是 L2」，大 plan 迭代时套 `subagent-driven-development` 的 batch + review 模式。
