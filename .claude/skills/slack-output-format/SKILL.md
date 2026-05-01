---
name: slack-output-format
description: Slack 频道结构化输出规范——标题主消息 + Block Kit thread 两步走。Use when 准备向非 DM 频道推送 cron 报告、审批卡片、反思/周报/持仓等结构化内容。
provenance: user-authored
---

# Slack 输出格式规范

所有向 Slack 频道（非 DM、非 thread 内回复）推送的结构化内容统一采用「标题主消息 + Block Kit thread」两步走。

## 1. 频道主消息（1 条，text only）

格式：`{emoji} {任务名} MM/DD｜{一句话总结}`

- emoji 选取按任务性质：🪞 反思、📈 持仓、📋 汇总、🔭 周报、📚 书签、🧘 冥想、🔀 路由、🔍 调研
- 一句话总结必须有信息量（核心发现 / 关键数据），不能是"完成"/"成功"
- 示例：`🪞 夜间反思 04/15｜8 条要点｜知识提取见 thread`
- 主消息**禁用 markdown 标题**（`#` 留给 thread reply）

## 2. Thread 正文（Block Kit）

结构：
```
header  : "{任务名} MM/DD"
section : "• 概况数据（窗口 / 会话数 / 消息数 / 标的数 等）"
divider
section : "## :emoji: 段标题\n正文..."
divider
section : "## :emoji: 段标题\n正文..."
divider
```

规则：
- 第 1 block 必须是 `header` 类型
- 每个正文 section 用 `## :emoji: 标题` + 换行 + 正文（adapter 自动转成 `*xxx*` 独立行 + 上空行）
- 段与段之间用 `divider` 分隔
- 风格：短句、高密度、可扫读
- 不要文档感，不要长段落

## 3. 语义 → markdown 对照表（核心）

完整 6 档映射见 `~/Orb/profiles/karry/workspace/CLAUDE.md` § Slack 输出格式。这里只列 cron / 反思类高频用法：

| 需要的视觉 | 写 | 渲染成 |
|---|---|---|
| 段标题 | `## :emoji: 标题` | `*:emoji: 标题*` 独立行 |
| 子段 | `### 子段` | `*子段*` 独立行 |
| 备注 / metadata | `#### 备注` | `_备注_` 独立行 |
| 句内重点 | `**关键词**`（一段 ≤1 个） | `*关键词*` 行内 |
| 数字 / ID / 路径 / 命令 | `` `xxx` `` | 灰底 |
| 弱强调 / 引用 / 术语 | `*xxx*` | `_xxx_` 行内 |

铁律：
- 段标题写 `## :emoji: 标题`，**禁止**直接写 `*标题*` 充当段标题
- 一段最多一个 `**bold**`；多了改用 `` `code` `` / 「中文引号」 / emoji 前缀（▸ → ✅）替代

## 4. Cross-call anchor 状态持久化

**触发场景**：同一类项目在一天内会被多次产出（new seed、bookmark 卡、cron 推送等），但希望它们**聚合到同一个 main thread**（首条创建、后续作为 thread reply 追加），跨日自动轮换到新 thread。

**反例（踩过的坑）**：依赖运行时猜测「今天有没有发过」——拉 conversations.history、对比时间戳、按文本匹配——任意一个都不可靠（频道有别人消息、time skew、文案变动），最终散成多个 main thread。已知案例：seeds_importers.py 早期实现散发，2026-04-27 才补 `data/seeds-daily-anchor.json` 闭环。

**正解**：把 anchor 持久化为显式 JSON 状态文件。

文件位置：`~/Orb/profiles/karry/data/<task>-daily-anchor.json`

最小 schema：
```json
{
  "date": "2026-04-28",
  "channel": "CXXXXXXXXXX",
  "main_ts": "1777306842.573899"
}
```

调用流程（每次要发新内容时）：
1. 读 anchor JSON，比对 `date` 字段：
   - 与今天（JST）一致 + `channel` 匹配 → 复用 `main_ts` 作为 thread_ts，发 thread reply
   - 不一致（跨日 / 切频道） → 走步骤 2
2. `chat.postMessage` 发 main 消息 → 拿到新 `ts`
3. 覆盖 anchor JSON：`{"date":"<today JST>","channel":"<C…>","main_ts":"<新 ts>"}`
4. 当天后续投递回到步骤 1

**铁律**：
- anchor 文件名必须含 `<task>-` 前缀，避免不同任务串台
- 跨日判定用 JST 日历日（`TZ=Asia/Tokyo date +%Y-%m-%d`），不要用 UTC
- 写 anchor 必须**先发消息拿到 ts、再写文件**，反过来会留下坏 anchor 指向不存在的 ts
- 不要靠扫频道历史「猜」今天是不是已经发过——历史会被别人插话污染

**适用任务清单**（已用 / 待补）：
- ✅ seeds_importers.py（new seed 当日聚合 → `seeds-daily-anchor.json`）
- ⏳ bookmark 卡片（如果想要当天书签都进同一个 thread）
- ⏳ cron 报告（多个 cron 想共享日级 anchor 时）

## 5. 频道主消息长度约束

主消息 text 段 ≤ 300 字（Slack 通知预览截断点）。超出的内容必须放 thread。
