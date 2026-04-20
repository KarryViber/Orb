# Split slack-cli-api-reference Skill

## 目标

把 `~/Orb/profiles/karry/workspace/.claude/skills/slack-cli-api-reference/SKILL.md`（当前 827 行）按 progressive disclosure 原则拆分，主文件保留 <150 行决策表 + 索引，详细内容转引用到 `references/` 子目录。

## 当前状态

单文件 SKILL.md，827 行，包含：
- Token 位置、基本认证
- chat.postMessage / update / delete / schedule 完整命令和参数
- Thread 相关（thread_ts 语义、reply_broadcast）
- Attachment + Block Kit 字段
- users.info / conversations.* 系列
- 各种脚本范例
- 常见坑点

每次 worker 启动都会扫 description，召回时注入全部 827 行 ≈ 8000 tokens，浪费。

## 目标结构

```
slack-cli-api-reference/
  SKILL.md              — ≤150 行：概念说明 + 决策表（什么场景读哪个 reference） + 核心命令索引
  references/
    messages.md         — chat.postMessage / update / delete / scheduleMessage 完整手册
    threads.md          — thread_ts 语义 / 回复 / reply_broadcast / 获取 thread
    blocks-attachments.md — Block Kit + Attachment 字段 + 示例
    users-channels.md   — users.info / users.list / conversations.info/list/members
    scripts.md          — 脚本范例（发卡片/批量读/权限检查）
    gotchas.md          — 踩坑集合（thread_ts float、token scope、rate limit 等）
```

## 拆分原则

1. **SKILL.md 主文件**只留：
   - frontmatter（description 不动）
   - 1 段概念引入（什么是 Slack CLI，token 在哪）
   - 决策表：「我要做什么 → 读哪个 reference」
   - 最常用 3-5 条命令的简表（chat.postMessage 最小调用、conversations.list、users.info）
2. **references/** 里每个文件自洽，能独立阅读
3. **不要丢内容**：原文件里每一条信息必须在某个 reference 里保留
4. **新增 gotchas.md**：把散落在正文里的 `[WARN]`、`坑`、`注意` 等提示集中过去

## 验收

1. `wc -l SKILL.md` ≤ 150
2. `cat references/*.md | wc -l` + `SKILL.md` 行数 ≥ 原 827 行（允许多，不能少）
3. SKILL.md 里必须有明确指引：「查 XX 功能见 references/YY.md」
4. git diff 能展示完整重构

## 不要做

- 不要改 frontmatter description（Karry 已审过）
- 不要删任何技术细节或坑
- 不要合并不同职责（messages vs threads 各成一文件）
- 不要改名字/路径之外的文件

## 范围

单 skill 目录重构，纯文档操作，不动代码。估 30 分钟。
