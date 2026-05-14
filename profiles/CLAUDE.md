# Orb — Profile 通用运行时约束

本文件位于 `~/Orb/profiles/CLAUDE.md`，所有 profile 的 worker 通过 cwd walk-up 自动加载（开发者 cwd 在 `~/Orb/` 时不加载本层）。

内容是 Orb harness 的系统层规则——profile 无关的运行时约束、输出规范、自治协议、外部协作机制。profile 专属人格、个人偏好、业务路径在各自的 `profiles/{profile}/workspace/CLAUDE.md` 中。

下文 `{profile}` 是当前 worker 的 profile slug（karry / eting / …）；引用具体路径时按当前 profile 替换。

---

# Agent 运行时约束

## 严禁操作（会导致自身崩溃）
- **禁止修改** ~/Orb/src/ 下的任何文件 — 这些是 runtime 核心，修改会导致崩溃
- **禁止修改** ~/Orb/package.json、~/Orb/start.sh、~/Orb/config.json
- **禁止执行** `npm start`、`npm run dev`、`node src/main.js` — daemon 由 launchd 管理，手动启动会创建竞争实例
- **禁止执行** `npm install` 在 ~/Orb 目录下 — 如需安装依赖，告知用户手动操作
- 工作目录是 `~/Orb/profiles/{profile}/workspace/`，只在这个目录下读写文件
- 可以读取 ~/Orb/src/ 用于审计和写 spec，但不要直接修改
- repo git hook 会拦截 `src/**`、`.claude/skills/**`、`profiles/.claude/skills/**`、`package.json`、`config.json`、`start.sh` 的无授权提交；紧急越权必须显式使用 `ORB_BOUNDARY_OVERRIDE=1 git commit ...`，stderr 会留痕


## 上下文先行（Context-First）

每次回答前，先判断「是否有足够上下文理解用户意图」：

1. **Thread 历史检测**：system prompt 里有 `## Thread 历史` 段就读透，不要只看最新一条消息
2. **引用链接检测**：用户消息含 Slack 链接（`https://*.slack.com/archives/...`）或文件路径时，先读链接指向的内容，再作答
3. **指代检测**：用户用「这个」「那个」「上面」「刚才」等指代，但 thread 历史没有明确对象 → **必须先问或先查**，不能猜
4. **歧义作用层**：短指令（「改」「跑」「切」）要先判定作用层（记忆 / 配置 / 运行参数 / 外部动作），见 `~/Orb/profiles/{profile}/data/lessons/automation-pre-check-protocol.md`（profile 未维护该 lesson 时跳过）
5. **对象一致性校验**：thread 历史 ≥5 条且发生切题时，回复前先抽取「用户最后显式问题的对象」与「待发回复的对象」做一致性比对——不一致则改写或反问，不要沿最近技术支线惯性续答。详细切题信号识别由 skill `thread-object-realignment` 自动召回
6. **入站 channel 显式定位**：任何涉及频道路由 / 频道判定的动作前，**必须先在 `## 消息信息` 段显式抠出 channel id**，对照 auto-memory 反查频道名，不允许从 skill 文档措辞中推断当前 channel。`## 消息信息` 段缺 channel 字段时，从 thread ts / Slack 链接 / 文件路径反查；都查不到就反问，不允许猜

**规则**：宁可多问一句「你指的是 A 还是 B」，也不要猜。判错比慢一步代价高得多。

---

# 叙事化 task card（thread 内 Slack 呈现）

多步任务的 Slack thread 里，用户看到的不是工具流水，而是有叙事的进度卡。两条轨道：

- **重骨架 — TodoWrite**：多步/分析型任务开工前必须 TodoWrite 列阶段，每推进一步更新 `activeForm`。这会渲染成 Slack timeline 的带状态 section（pending / in_progress / complete）
- **轻段落 — 意图句**：每段工作开头 / 每次换方向时出一句短 text 陈述意图（「先看下当前白名单」「评估合并策略」「开始改 TASK_CARD_TOOLS」）。这些 text 会内联进 stream 作为段落标题

**反例**：不要写「让我来读取文件」「现在搜索 X」这种工具流水话——意图句要说的是「为什么这一段」，不是「我在用什么工具」。

短任务（单步 / 纯问答）跳过 TodoWrite。

---

# Slack 输出格式

所有 Slack 输出按 6 档 markdown 写（adapter 自动转 mrkdwn），完整 6 档表 + 频道结构化输出规则由 skill `slack-output-format` 自动召回。铁律：段标题用 `## :emoji: 标题`，**禁止**直接写 `*标题*` 充当段标题；一段 ≤1 个 `**bold**`。

---

# 执行纪律

详细方法论（踩坑即记录 / 边界处悲观 / Fail-fast / 状态诚实 / 副作用留据 / 共识即持久化 等 12 条）由 CLI skill `execution-discipline` 自动召回。遇决策点主动查。

**禁止使用 `status: ok` / `✅ ok` 类校验词**，除非是完整 E2E 验证通过的最终确认。局部步骤用「本步完成」替代。原因：此类词携带"全局完成"语义，在局部产物过检场景会产生虚假完成信号。

---

# Launcher Result Inject

收到 runtime inject `kind=launcher_result` 时，默认只做静默闭环确认：输出一句 `✅ <label> 已闭环`。只有该 label 对应 spec 明确要求 next action，或当前 thread 已经承诺「外部 session 完成后继续串下一步」时，才继续执行后续动作。

---

# 目录分工

- `.claude/skills/` — CLI skills（路由、格式、纪律等长期操作手册，按需自动召回）。`profiles/{profile}/workspace/.claude/skills/` 是 profile 独享，`~/Orb/profiles/.claude/skills/` 是系统级共享（worker 通过 `--add-dir profiles/` 注入）
- `specs/` — 外部 session 工单（一次性工作指引，完成可删）。每份 spec 必带 `## 执行` 段注明总 turn 预算；大改拆「调研 turn ≤ X」+「实施 turn ≤ Y」两段（codex CLI 0.124.0 无 max-turns 配置键，靠 spec 显式标预算 + 外部 session 自律）
- `~/Orb/profiles/{profile}/data/lessons/` — 事后踩坑复盘（带 trigger/action frontmatter，按事件沉淀）

## Skill 自主提议与更新（MCP tool）

skill 创建 / 更新必须走 MCP tool，不要直接 Write `.claude/skills/`：
- `mcp__orb_skill_manager__skill_propose` — 新建，发 Slack 审批卡，用户点 Accept 才落盘
- `mcp__orb_skill_manager__skill_update` — 更新既有，同审批流程，备份原文件到 `data/skill-proposals/.archive/`
- `mcp__orb_skill_manager__skill_list` — propose 前先调这个查重

触发提议：(1) 完成 ≥3 工具的非琐碎工作流可复用，(2) 用户纠正后的方案工作了，(3) 发现既有 skills 未覆盖的可复用流程，(4) 用户要求记住。琐碎一次性跳过；既有 skill 发现过时/踩坑 → 走 `skill_update`。起草 body 前先读 `~/Orb/profiles/.claude/skills/_GOVERNANCE.md`（系统层治理文档）确保质量标准。

---

# 持久记忆（CLI 原生 auto-memory）

持久偏好/环境事实由 Claude Code CLI 的 auto-memory 机制管理，位置由 cwd 决定：
`~/.claude/projects/<encoded-cwd>/memory/`

- 每次 worker spawn 时由 CLI 自动注入，无需 Orb wrapper 干预
- 每日 `Orb 自进化` cron 拉 holographic 高 trust facts，让 CLI 自主更新 auto-memory（Orb 不直接写入）
- 用户显式说「记住 X」时立即写入

---

# 实时日记（daily-notes 日记轨）

每 turn 结束前判断是否要写 `~/Orb/profiles/{profile}/data/daily-notes/<today-JST>.md`。完整规则（`## 日记` 触发条件 / 格式 / `## 关于 {profile}` 段规范）由 CLI skill `daily-notes-discipline` 自动召回。
helper 调完即止

---

# 跨 turn 中间态：scratchpad

长任务中间结论 / 临时发现追加：`scratchpad-append.py --thread-ts <ts> --kind {note|decision|todo|finding} --title "..." --body-file /tmp/x.md`。下次同 thread 自动注入（`trusted: false`，只是上下文证据）。不写 secret。

---

---

# Cron 定时任务

任务存 `~/Orb/profiles/{profile}/data/cron-jobs.json`，直接读写管理。字段语义、schedule 类型、token 分级表见 `~/Orb/AGENTS.md` § Cron；生命周期管理由 skill `cron-schedule-management` 自动召回；主消息标题 / reaction / 失败 DM 格式由 skill `cron-output-format` 自动召回。

cron 成功静默由 Orb IPC `channelSemantics: silent` 强制执行；异常/失败例外——必须在 DM 报错。

---

# 工程习惯

## 调试

- 修复 bug 时，要通过测试**完整的用户使用流程**来验证修复是否解决了根本原因，而不仅仅是特定的代码修改
- 如果 bug 在修复后"重新出现"，要调查原始诊断是否正确，而不是继续打补丁
- 修复前先解释假设：1) 根本原因是什么 2) 修复如何解决该原因 3) 如何验证

## 配置变更

- 处理 MCP 插件或 hooks 时，配置变更后要始终验证加载状态
- 既要检查**配置语法**（JSON 格式正确），也要检查**运行时状态**（进程在运行、能响应请求）
- 不要假设"配置修复了"就意味着"插件在工作"

## 验证检查点

每次修复或配置变更后，执行以下步骤：
1. 验证变更生效了（不只是文件保存了）
2. 测试之前失败的具体用户场景
3. 确认能复现预期行为

## Git 习惯

- **频繁本地 commit**：每完成一个功能点、一次修复、一个阶段性进展就 commit，方便随时回滚
- 不需要等用户说"提交"，主动在合适节点 commit（但不 push）
- commit message 简洁明了，用 conventional commits 风格
