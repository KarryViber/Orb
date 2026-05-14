---
name: slack-output-format
description: Slack 频道结构化输出规范 + Web API 写法——标题主消息、Block Kit thread、6 档 markdown、跨调用 anchor、curl/token/读写消息命令。Use when 准备向非 DM 频道推送 cron 报告/审批卡/反思/周报/持仓/书签/调研，或需要用 Slack API 读写消息、管理 thread、发送 Block Kit/attachment、更新并回读验证。
---

# Slack 输出格式规范

所有向 Slack 频道（非 DM、非 thread 内回复）推送的结构化内容统一采用「标题主消息 + Block Kit thread」两步走。Slack Web API 主要通过 `curl` + Bot token 调用；token 存在 `~/Orb/.env`，不要直接 `source ~/Orb/.env`，而是单独提取变量。

## When to Use

- 准备向非 DM 频道推送 cron 报告、审批卡片、反思、周报、持仓、书签、调研等结构化内容
- 需要设计 Slack 主消息、thread Block Kit、markdown 层级或跨调用 thread 聚合
- 需要用 Slack Web API 读写消息、管理 thread、发送 Block Kit / attachment、更新或回读消息

## 频道主消息（1 条，text only）

格式：`{emoji} {任务名} MM/DD｜{一句话总结}`

- emoji 选取按任务性质：🪞 反思、📈 持仓、📋 汇总、🔭 周报、📚 书签、🧘 冥想、🔀 路由、🔍 调研
- 一句话总结必须有信息量（核心发现 / 关键数据），不能是"完成"/"成功"
- 示例：`🪞 夜间反思 04/15｜8 条要点｜知识提取见 thread`
- 主消息**禁用 markdown 标题**（`#` 留给 thread reply）
- 主消息 text 段 ≤ 300 字（Slack 通知预览截断点）。超出的内容必须放 thread。

## Thread 正文（Block Kit）

结构：

```text
header  : "{任务名} MM/DD"
section : "• 概况数据（窗口 / 会话数 / 消息数 / 标的数 等）"
divider
section : "## :emoji: 段标题
正文..."
divider
section : "## :emoji: 段标题
正文..."
divider
```

规则：

- 第 1 block 必须是 `header` 类型
- 每个正文 section 用 `## :emoji: 标题` + 换行 + 正文（adapter 自动转成 `*xxx*` 独立行 + 上空行）
- 段与段之间用 `divider` 分隔
- 风格：短句、高密度、可扫读
- 不要文档感，不要长段落

## 语义 → markdown 对照表（核心）

完整 6 档映射见 `~/Orb/profiles/<your-profile>/workspace/CLAUDE.md` § Slack 输出格式。这里只列 cron / 反思类高频用法：

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

## 小字（italic / context 灰字）使用频次

**目标**：把正常字号的信噪比拉高。Karry 一眼能 grep 到「需要回应的部分」，辅助信息全沉到小字。

**默认走小字**（`*xxx*` → 渲染成 `_xxx_` italic；多行可用 context block）：

- 来源标注：`_来源：plaud bc4b8b1d / canon L1 / commit ce0fe16_`
- 时间戳 / 路径 / 文件名（非链接的）：`_2026-05-14 08:34 JST_` / `_src/adapters/slack-format.js:601_`
- 工具 / API 副作用回执：`_freee PUT 200 · receipt 关联完成_`
- 推理链 / 思考路径（「我先 X 再 Y」类的过程交代）
- 备选方案 / Plan B / 可选项的展开
- 兜底说明 / 「如需展开说一声」
- cron 身份戳 / window 元数据
- 引用片段 / 节录原文（Karry 已经知道是引用的）

**正常字号留给（信号位）**：

- 结论 / 判断 / 推荐
- 下一步动作 / 待 Karry 决策
- 反问 / AskUserQuestion 之外的关键追问
- 风险 / 警告 / 失败原因
- 改动结果 ≤ 2 行的核心摘要

**禁忌**：

- 任何「写完就行」的回执（diff、日记、scratchpad）→ 完全静默，不写小字（runtime 已关掉 dailyNotes/diff context 自动注入，2026-05-14）
- 一条消息 ≥ 3 段连续灰字 → 折叠合并为一段，或干脆删掉
- 结论藏小字 = 没说

## Slack API 写法

### 1. 提取 token

```bash
SLACK_BOT_TOKEN=$(grep -E '^SLACK_BOT_TOKEN=' ~/Orb/.env | head -1 | cut -d= -f2- | tr -d "'" '"')
```

### 2. 发最小消息

```bash
curl -s "https://slack.com/api/chat.postMessage" \
  -d "channel=C01ABC123" \
  -d "text=Hello, Slack!" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

发 thread reply、update、delete、schedule、unfurl 时同样使用 Bot token 和对应 Web API。发完消息后，优先用 `conversations.replies` 或 `conversations.history` 回读验证，不要只看 `ok=true`。

### 3. 读取一个 Thread

```bash
curl -s "https://slack.com/api/conversations.replies" \
  -d "channel=C01ABC123" \
  -d "ts=1775307969.013919" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

### 4. 列频道

```bash
curl -s "https://slack.com/api/conversations.list" \
  -d "limit=200" \
  -d "types=public_channel,private_channel" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

### 5. 查用户

```bash
curl -s "https://slack.com/api/users.info" \
  -d "user=U01ABC123" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

### 6. 添加 Reaction（任务完成 / 确认标记）

```bash
curl -s https://slack.com/api/reactions.add \
  -d "channel=C01ABC123" \
  -d "timestamp=1775308000.100001" \
  -d "name=white_check_mark" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

`name` = 不带冒号的 emoji slug（`thumbsup` / `white_check_mark` / `eyes` / `x`）。需要 Bot scope `reactions:write`。

## 收到用户附件时的处理

Orb adapter 对不同文件类型的处理结果：

| 文件类型 | agent 拿到 | 应对方式 |
|---|---|---|
| .txt / .md / .json / .py 等文本类 | `--- 文件: xxx ---\n内容\n--- EOF ---` 注入 prompt | 直读，正常响应 |
| 图片（.png / .jpg / .gif 等） | imagePaths，作为多模态 image block | 直接视觉分析 |
| **PDF** | `[附件: xxx (application/pdf, N bytes)]` | 调 `pdf` skill：`pymupdf` 提取文本 |
| **docx** | `[附件: xxx (application/vnd.openxmlformats..., N bytes)]` | 调 `ocr-and-documents` skill：`python-docx` |
| **xlsx / csv** | `[附件: xxx (application/vnd.openxmlformats..., N bytes)]` | 调 `xlsx` skill：`openpyxl` / `pandas` |
| 超 100KB 文本 | `[附件: xxx — 超出大小限制]` | 告知用户文件过大，建议拆分或提供关键片段 |

**铁律**：收到 `[附件: xxx]` 格式提示时，不能沉默——必须明确告知用户「已收到文件，正在用工具提取内容」，并主动调对应 skill，不要假装没看见或只输出文件名。

## 跨调用 Anchor 持久化

**触发场景**：同一类项目在一天内会被多次产出（new seed、bookmark 卡、cron 推送等），但希望它们**聚合到同一个 main thread**（首条创建、后续作为 thread reply 追加），跨日自动轮换到新 thread。

**反例（踩过的坑）**：依赖运行时猜测「今天有没有发过」——拉 conversations.history、对比时间戳、按文本匹配——任意一个都不可靠（频道有别人消息、time skew、文案变动），最终散成多个 main thread。已知案例：seeds_importers.py 早期实现散发，2026-04-27 才补 `data/seeds-daily-anchor.json` 闭环。

**正解**：把 anchor 持久化为显式 JSON 状态文件。

文件位置：`~/Orb/profiles/<your-profile>/data/<task>-daily-anchor.json`

最小 schema：

```json
{
  "date": "2026-04-28",
  "channel": "C0123456789",
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

## Assistant Thread / Stream API（只读参考，不要直接调）

以下 API 归 Orb adapter/scheduler 独占管理，**外部脚本和 agent 不要直接调用**，否则会踩 `message_not_owned_by_app` / `message_not_in_streaming_state`：

| API | 归属 | 说明 |
|---|---|---|
| `assistant.threads.setStatus` | adapter | 显示 "Cooking…" / 工具名等气泡，turn 期间自动刷新（每 20s re-arm） |
| `assistant.threads.setTitle` | adapter | 设置 assistant thread 标题 |
| `assistant.threads.setSuggestedPrompts` | adapter | 设置建议提示词 |
| `chat.startStream` | scheduler | 启动 task card timeline stream |
| `chat.appendStream` | scheduler | 向 stream 追加 task_update chunks |
| `chat.stopStream` | scheduler | 关闭 stream 并写入最终 markdown/blocks |

**handler 脚本**（`profiles/<your-profile>/scripts/handlers/`）收到 block_action 回调后用 `chat.update` 更新审批卡，**不要**尝试用 stream API 改 bot 发的消息——stream 所有权归 daemon，handler 拿不到。

### Stream chunks 双发陷阱（写 stream renderer / 改 stopStream 前必读）

Slack stream 的 `task_update.details` 对**同一个 id 的 chunk** 会**跨 `appendStream` concat 累积**——这是官方未明文但实测稳定的行为。

**事故签名**：finalize 后文本重复，例如 `Distilled from N probesDistilled from N probes`。

**根因**：result/finalize 路径先 `appendStream(chunks)` 再 `stopStream({ chunks })` 发送同一批 final chunks，Slack 把 details 又拼了一次。

**正确姿势**：

- 实时增量**只**通过 `appendStream` 发 delta
- result/finalize **只**调用 `stopStream({ chunks: lastChunks })`——不在 stop 前再 append 同一批
- catch / fallback / abnormal exit 路径也别补发 final chunks

**审查 stream renderer 时盯这几条路径**：

- `cc_event result`
- abnormal exit finalize
- deferred stream stop
- 任何 catch/fallback 里补发 final chunks 的逻辑

参考 lesson：`profiles/<your-profile>/data/lessons/slack-stream-stopstream-chunks-pitfall.md`

## Reference 索引

命令语法、URL→ts 转换、`reactions.add`、文件上传 v2（`getUploadURLExternal`）、`chat.getPermalink`、频道/用户查询、cursor 分页、常见报错全集，见 skill **`slack-cli-api-reference`**（搜索关键词 `invalid_blocks` / `reactions.add` / `getUploadURLExternal` / `chat.getPermalink` / `conversations.replies` 时自动触发）。

## Gotchas

- 默认优先 top-level `blocks`，只有明确需要色条时才用 `attachments`。
- 长内容优先拆成多条 thread reply，不要把风险压在一条超长消息上。
- 用户反馈"没发全"时，先回读 Slack 实际落地结果，再决定补发或更新。
- 跨调用聚合发布必须用磁盘 anchor，禁止靠运行时猜测。
- 收到 `[附件: xxx (mime, size)]` 时必须主动调对应 skill 提取内容，不能忽略或只输出文件名。
- 遇到 `invalid_blocks`、只剩首行、空壳消息、`source ~/Orb/.env` 失败等问题，查 `slack-cli-api-reference` skill。
