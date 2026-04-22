# Clarify Gate — 上下文先行的硬化

## 背景

`profiles/karry/workspace/CLAUDE.md` 里已有「上下文先行」软规则：短指令 + 指代词 + thread 无明确对象时必须先问。但软规则不可靠，Karry 在 2026-04-18 已经撞过一次坑（夜间反思 04/18 的追问被误解为新问题）。

本 spec 把它从"约束文本"升级为"注入式 directive + 关键词预警"。不做工具级 gate（Claude Code CLI 不支持 agent 自定义 tool 拦截），改为前置 directive + 自检。

## 目标

1. 每次 worker 启动，注入一条明确的 directive，列出必须澄清的触发条件和规范动作
2. 在 buildPrompt 里检测用户消息是否命中触发条件，命中则额外追加一条强提示到 userPrompt 末尾

## 改动范围

只改 `~/Orb/src/context.js`，不碰 worker / scheduler。

### 改动 1：新增 framework directive 常量

在 `MEMORY_GUIDANCE` 旁边追加：

```js
const CLARIFY_DIRECTIVE = `\
上下文先行是硬约束，不是建议：

触发条件（任一命中即必须先澄清）：
- 用户消息含指代词（「这个」「那个」「上面」「刚才」「它」），但 Thread 历史里无明确唯一对象
- 用户消息是短指令（≤6 字），且作用层模糊（可能指记忆 / 配置 / 运行参数 / 外部动作中的多个）
- 用户引用 Slack 链接 / 文件路径 / 消息 ID，但你没有读取其内容

规范动作：
- 先发一句澄清问题，列出你理解的候选项（A / B / C），让 Karry 选
- 或先调工具读取引用内容，读完再作答
- 严禁直接猜意图后进入副作用操作（写文件、发消息、改配置）

判断成本低，猜错代价高。宁可多问一句。`;
```

### 改动 2：默认注入该 directive

在 `buildPrompt` 内 `MEMORY_GUIDANCE` 注入块后面加：

```js
systemParts.push(CLARIFY_DIRECTIVE);
```

位置：`src/context.js:186` 之后。

### 改动 3：触发预警（运行时检测）

在 Layer 4（Thread 历史）注入之后，userPrompt 组装前，增加一个触发检测：

```js
// Clarify gate — detect ambiguity triggers and prepend a strong prompt
const pronouns = /[这那]个|上面|刚才|之前说的|它|他们/;
const shortCmd = (userText || '').trim().length <= 6;
const hasSlackLink = /https:\/\/[a-z0-9-]+\.slack\.com\/archives\//.test(userText || '');
const triggered = pronouns.test(userText || '') || shortCmd || hasSlackLink;
if (triggered) {
  userParts.push(`## ⚠️ Clarify Gate\n检测到歧义触发条件（短指令 / 指代词 / 外部引用）。作答前复核：你是否已经读透 Thread 历史和被引用内容？若有任何不确定，先澄清再行动。`);
}
```

放在 `userParts.push(\`## 用户消息...\`)` **之前**，这样用户消息仍是最后一条（保留 Claude 的 recency 权重）。

## 验收

1. `grep CLARIFY_DIRECTIVE ~/Orb/src/context.js` 有命中
2. 启动 daemon，DM 发「改一下」，worker 应该先回澄清问题而不是直接动手
3. DM 发「帮我重构 session.js 的 saveSession 函数」，不应触发（长指令、无指代词、无外部链接），直接执行

## 不做

- 不改 SOUL.md（这是运行时机制，不是人格）
- 不加新工具 / IPC 消息类型
- 不做 post-hoc 自检 hook（stop hook 里做判断会增加复杂度，而且命中概率低 — 前置 directive 已经足够）

## 工作量

单文件改动，< 50 行。预计 30 min 实施 + 30 min 本地验证。
