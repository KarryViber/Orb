# Skills 共享词表

借鉴 mattpocock/skills 的 `LANGUAGE.md` pattern。本文件不是教程，是术语硬约束——写 / 改 / 评审 SKILL.md 时用这些词，避免同义漂移。

适用范围：`~/Orb/profiles/<your-profile>/workspace/.claude/skills/` 全部 SKILL.md、`_GOVERNANCE.md`、`_AUDIT_*.md` 以及 lessons 里讨论 skill 体系的段落。

---

## 1. Artifact 词

**Skill**
有触发条件、可被 CLI 自动召回的可复用操作手册。位于 `.claude/skills/<name>/SKILL.md`。
_Avoid_: rule、guide、doc、规范——这些词不带「召回」语义，会模糊 skill 与 CLAUDE.md 的边界。

**CLAUDE.md**
每个 turn 都注入的硬约束 + 人格。无召回门槛——所以只放「永远成立」的内容。
_Avoid_: 把它叫「persona file」「prompt」——前者只覆盖人格段，后者跟「user prompt」混淆。

**Spec**
一次性工单，位于 `workspace/specs/<name>.md`，给外部 session 执行。完成后可删。
_Avoid_: ticket、issue、task——前两者暗示外部追踪系统，task 跟 TodoWrite 撞名。

**Lesson**
事后踩坑复盘，位于 `~/Orb/profiles/<your-profile>/data/lessons/<topic>.md`，带 trigger/action frontmatter。**不是 skill**——没有召回机制，靠 grep 主动检索。
_Avoid_: postmortem（暗示重大事故才写）、note（太轻）。

**Auto-memory**
Claude Code CLI 原生的 cwd-keyed 持久记忆，位于 `~/.claude/projects/<encoded-cwd>/memory/`。Orb 不直接写，由每日 01:15 自进化 cron 间接刷新。
_Avoid_: 把它跟 `~/Orb/profiles/<your-profile>/data/MEMORY.md` 混称——后者已孤儿，不再读写。

**Handler**
Slack 按钮 `block_action` 的确定性路由脚本，位于 `profiles/<your-profile>/scripts/handlers/<action_id>.{py,sh,js}`。adapter 直接执行，**零 LLM**。
_Avoid_: callback、webhook——后者暗示外部 HTTP 入站。

---

## 2. 行为词

**召回（recall / trigger）**
CLI 根据 description 自动加载某 skill 的过程。判据：用户语义 + description 关键词匹配。
_Avoid_: 「调用 skill」——skill 不是函数，agent 不主动 invoke，是 CLI 注入。

**Progressive disclosure（渐进披露）**
SKILL.md 主文件只放高频内容，次要拆 subfile 让 agent 按需读。
_Avoid_: 拆分、模块化——后两者不带「按需加载」语义。

**Pressure test（行为验证）**
propose skill 前用 subagent 跑 baseline → 起草 → verify 三步，确认 skill body 真改变了 agent 行为。
_Avoid_: 测试、review——前者像跑断言，后者像看代码，都不传达「行为对照实验」。

**孤儿（orphan）**
被引用了但目标不存在 / 已废弃但仍有指针 / 自己引入的未用 import 等。surgical-changes 偏好里要清自己造的孤儿，不动既存 dead code。
_Avoid_: 死代码（dead code）——后者外延更宽，包含「曾用过现已无用」，与「自己刚引入未用」要分开。

---

## 3. 原则

- **触发器 ≠ 摘要**。Description 决定 CLI 是否召回这个 skill。没有 `Use when` / 触发关键词的 description = 永远不会被自动调用。
- **Skill 是塑造行为的代码，不是文档**。判据：能说出「没这个 skill 时 agent 会 X，有了会 Y」。说不出 → 改成 lesson 或并入 CLAUDE.md。
- **一次性 ≠ 可复用**。一次性工作开 spec，事后沉淀写 lesson。skill 必须满足「同类场景会再发生 ≥3 次」。
- **召回成本 = 全文注入**。SKILL.md 每多 100 行，召回一次多烧约 400 tokens × 召回频率。删一行胜过加一段。

---

## 4. Skill / CLAUDE.md / Spec / Lesson 决策表

| 内容性质 | 归属 |
|---------|------|
| 每个 turn 都要遵守 | CLAUDE.md |
| 条件性触发，可复用 | Skill |
| 一次性工单 | Spec |
| 事后踩坑复盘 | Lesson |
| 持久偏好 / 环境事实 | Auto-memory |

边界判据：**有明确召回条件**才是 skill。无召回条件 + 全局适用 = CLAUDE.md。无召回条件 + 一次性 = spec。无召回条件 + 事后 = lesson。

---

## 5. Rejected framings

明确拒绝的词法/思路：

- **「Skill = 文档」**：skill 注入即生效，会改变 agent 后续动作；文档不会。混称会导致 skill 写成知识库条目而非操作手册。
- **「Skill 越多越好」**：召回成本是真金白银的 token + 召回精度被稀释。判据是「这件事会再发生」，不是「这件事记下来不亏」。
- **「Description 写得文雅」**：description 是 fuzzy match 的关键词靶子，不是面向人的摘要。要硬塞触发场景关键词、URL pattern、用户原话。
- **「Lesson 攒够了升级成 skill」**：lesson 是事件流水，skill 是行为模板。lesson → skill 要重写，不是加 frontmatter。
- **「Auto-memory 是 KV store」**：auto-memory 走 CLI 自己的检索逻辑，写入要符合 CLI 期望的格式。Orb 不直接 append。
- **「CLAUDE.md 是兜底」**：CLAUDE.md 每 turn 全量注入，写进去的代价是永久性的 context 税。不是「不知道放哪就丢这」。

---

## 6. 关系

- 一个 **Skill** 有唯一 **Description**（决定其召回条件）和零或多份 **Subfile**（progressive disclosure 拆出去的次要内容）。
- 一个 **Lesson** 有唯一 **Trigger**（grep 锚点），可能催生 **Skill**（重写后）或补丁 **CLAUDE.md**（升格为硬约束）。
- 一个 **Handler** 唯一对应一个 Slack `action_id`，由 adapter 而非 agent 执行。
- **Spec** 不进入 skill 体系——它是给外部 session 的工单，完成即可删。
