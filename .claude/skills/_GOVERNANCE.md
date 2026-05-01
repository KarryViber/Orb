# Skills 治理规范

基于 Anthropic《Lessons from Building Claude Code: How We Use Skills》+ Orb workspace 实践沉淀。

适用范围：`~/Orb/.claude/skills/`（system-scope，跨 profile 共享）+ `~/Orb/profiles/<your-profile>/workspace/.claude/skills/`（workspace，单 profile）下的所有 SKILL.md。全局 `~/.claude/skills/` 沿用同标准但仅建议不强制。三层 scope 划分见 § 6。

> 词法约束见 `_LANGUAGE.md`——本文件谈规则，那份谈用词。propose / 审 / 改 skill 前先扫一眼词表，避免 skill / lesson / spec / CLAUDE.md / auto-memory 同义漂移。

---

## 1. 核心原则

### 1.1 Description 是触发器，不是摘要
Description 决定 CLI 是否自动召回这个 skill。写法：

**好**：`Slack DM (D0ANGB3M1CZ) 入站路由协议。Use when DM 消息含 x.com/twitter.com/github.com 链接或 PDF invoice 附件`
**坏**：`Slack DM 路由的相关规则和配置`

规则：
- 首句一句话说清职责
- 带 **Use when** / **触发** / **适用场景** 明确召回条件
- 列出具体关键词（URL 模式、文件类型、用户用语）让 CLI 匹配更准
- 长度 80-200 字之间——太短匹配不精，太长稀释关键词

### 1.2 渐进式信息披露（Progressive Disclosure）
SKILL.md 主文件只放**必要且高频**的内容。次要信息拆到同目录子文件（`references.md` / `examples.md` / `gotchas.md`），让 agent 需要时再读。

理由：每次召回都会把整份 SKILL.md 注入 context。400 行和 40 行的 token 成本差 10 倍。

### 1.3 Gotchas section 必备
每个处理外部系统 / 有踩坑历史 / 接口易变的 skill，必须有独立 **Gotchas / 踩坑** 小节。
不要把坑埋在正文段落里，单独列才能让 agent 快速定位回避。

### 1.4 不写显而易见的事
删除：
- 「请仔细阅读以下内容」这种程序性废话
- 重复 CLAUDE.md 已有约束的段落
- 简单到 agent 常识就能处理的步骤

保留：只有这个 skill 独有的知识 + 反直觉的约束。

---

## 2. 结构模板

```markdown
---
name: <kebab-case-name>
description: <一句话职责> + Use when <具体触发条件>。
---

# <Title>

## When to Use（或「触发条件」）
- 场景 1
- 场景 2

## <核心内容：规则 / 步骤 / 模板>

## Gotchas（或「踩坑」）
- 坑 1 + 规避方法
- 坑 2 + 规避方法
```

命名：
- 目录名和 frontmatter `name` 必须一致
- kebab-case，全小写
- 避免缩写（`ldp-order-mgmt` 改成 `longport-order-management`）
- 同类技能用前缀分组（`longport-holdings-check` / `longport-order-management`）

---

## 3. 分类体系（参考 Anthropic 9 类精简到 5 类）

| 类别 | 用途 | 示例 |
|------|------|------|
| **协议类** | 格式/流程规范 | dm-routing, slack-output-format, compliance-delivery-checklist |
| **工具类** | 调外部 API / CLI 的封装 | browser-cdp, longport-*, plaud-api, slack-cli-api-reference |
| **纪律类** | 决策/执行原则 | execution-discipline, execplan, skill-factory |
| **领域类** | 特定业务知识 | longport-order-management 踩坑 |
| **路由类** | 元 skill（管理其他 skill） | skill-factory, skill-factory-aggregator |

---

## 4. 判定流程：保 / 合 / 删

新增或审查 skill 时，按顺序问：

1. **Description 是否能触发正确召回？**
   - 否 → 改 description，不动 body
2. **内容是否与另一个 skill 重叠 > 60%？**
   - 是 → 合并，留大的删小的
3. **过去 30 天是否被召回过？**（若有日志）
   - 否 → 标记删除候选，观察 30 天再删
4. **是否可直接从 CLAUDE.md / workspace 代码推断？**
   - 是 → 删除（knowledge 不是 skill）
5. **单文件是否 > 300 行？**
   - 是 → 按 § 1.2 拆出 subfile

---

## 5. 何时写 skill vs 何时写进 CLAUDE.md

| 条件 | 归属 |
|------|------|
| 每个 turn 都要遵守 | CLAUDE.md（硬约束 / 人格） |
| 条件性触发 | skill（按 description 召回） |
| 一次性工单 | specs/ 不走 skill |
| 事后复盘 | ~/Orb/profiles/<your-profile>/data/lessons/（不是 skill）|

硬判据：**skill 必须有明确的召回条件**。没有触发器的内容不是 skill，是文档。

---

## 6. 维护节奏

- **新建时**：按 § 2 模板，过一遍 § 4 判定
- **季度审查**：跑 `_AUDIT_WORKSPACE.md` 重新评估（skill-factory-aggregator 可自动化一部分）
- **发现坑**：立即补 Gotchas，不要等积累
- **合并/删除**：从 index 移除 + 目录 `rm -rf`，git 留痕即可

---

## 7. Pressure Test：落盘前的行为验证

Skill 是塑造 agent 行为的「代码」，不是文档。没跑过行为验证就 propose，等于写了没测过的代码。

**propose 前强制流程（≥3 turn 非琐碎 skill 适用；纯参考类 / 踩坑记录类可跳过）：**

1. **Baseline**：选 3 个该 skill 目标触发的真实场景，用 Task tool 派 subagent（**不**给 skill body，只给用户原话），观察它怎么错 / 偏 / 绕路。记下 3 个失败 pattern。
2. **起草 body**：针对观察到的失败 pattern 写规则，而不是凭想象写「应该怎么做」。
3. **Verify**：同样 3 个场景再派 subagent（这次给 skill body），确认行为变了。没变 → skill body 没切中真问题，重写。

**核心判据**：你得能说出「没有这个 skill 时 agent 会 X，有了会 Y」。说不出 → 这 skill 是贴膜。

**例外放行**：
- 纯事实 / API 参考类（`slack-cli-api-reference`, `longport-*-check`）
- 事后踩坑沉淀（一次性 bug 的复盘，不是可复用流程）
- 用户显式要求记住的单条规则

**反例**：看了好文章想抄一套方法论 → 先跑 baseline 确认 agent 真不会，再决定写不写。抽象漂亮但 agent 本来就能做对的，不写。

---

## 8. 反模式清单

❌ Description 写成摘要而非触发条件
❌ 没有 Gotchas section（外部系统/易变接口 skill）
❌ 把 CLAUDE.md 内容复制一份到 skill
❌ 单文件超 500 行却没拆 subfile
❌ 命名跟目录不一致
❌ 多个 skill 讲同一件事（如 execplan 和 long-task-optimization 高度重叠）
❌ 描述里写「一般来说」「可能会」——触发器要确定性的关键词

---

## Skill 分层 scope

四层加载位置（CC CLI native + Orb wrapper），优先级 high → low：

| Scope | 路径 | 加载方式 | 适用范围 |
|---|---|---|---|
| Personal | `~/.claude/skills/` | CLI native（user-level） | 全用户跨项目 |
| **System** | `~/Orb/.claude/skills/` | CLI `--add-dir ~/Orb`（Orb worker 注入） | **karry + eting 共享** |
| Workspace | `profiles/{name}/workspace/.claude/skills/` | CLI cwd auto-discovery | 单 profile |

### 归属判断

- **System**: 与「是谁」无关、Orb 框架级——纪律 / 调试 / 验证 / 协议工具。例：`execution-discipline`、`commit-lineage`、`truth-ladder`、`verification-before-completion`、`vendor-api-param-validation`、`compliance-delivery-checklist`
- **Workspace**: 与「哪个 agent persona / 哪个 codebase」绑定——人格、平台帐号专属、客户工具。例：`dm-routing`、`x-twitter`、`longport-*`、`plaud-api`、`infocard`

### 新建判断默认

`mcp__orb_skill_manager__skill_propose` 默认 `scope=profile`（写 workspace）。仅在确认「跨 profile 共享」时显式指定 `scope=system`。判错可后续 update 改 scope（先删旧位置 → 新建新位置 → audit log）。

### 同名冲突

CLI 优先级：Personal > Project（Workspace） > add-dir 加载（System）。即 workspace 同名会覆盖 system 同名。这与「cwd 优先」自然层叠一致。`_AUDIT_*` 工具应能列出被覆盖项。
