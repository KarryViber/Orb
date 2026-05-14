---
name: slack-cli-api-reference
description: Slack Web API curl 命令参考——发/更/删消息、thread reply、reactions.add、文件上传 v2、读 thread、频道/用户查询、Block Kit 选型、token 提取、URL→ts 转换、常见坑全集。Use when 查 API 命令语法/参数、排查 `invalid_blocks`/`not_in_channel`/`missing_scope`/消息只剩首行/attachment 静默丢失、或需要 `reactions.add`/`files.getUploadURLExternal`/`chat.getPermalink` 的具体 curl 示例。
---

# Slack Web API curl 参考手册

## When to Use

- 查具体 curl 命令参数（channel、ts、blocks 字段格式）
- Slack URL → timestamp 转换
- 排查 `invalid_blocks` / `not_in_channel` / `missing_scope` / 消息只剩首行
- 需要 `reactions.add` / 文件上传 / `chat.getPermalink` 的完整示例

## Token 提取（必用）

```bash
SLACK_BOT_TOKEN=$(grep -E '^SLACK_BOT_TOKEN=' ~/Orb/.env | head -1 | cut -d= -f2- | tr -d "'" '"')
```

**禁止** `source ~/Orb/.env`——第 26 行 `SLACK_HOME_CHANNEL_NAME=Karry Slack DM` 未加引号，bash 会把 `Slack DM` 当命令执行 → `bash: Slack: command not found`。

必需 Bot Scopes：`channels:history` · `channels:read` · `groups:history` · `chat:write` · `chat:write.public` · `users:read` · `files:write` · `reactions:write`

---

## 发送消息

### 发文本 / Thread Reply

始终用 `Content-Type: application/json`——form-encoded 传 `attachments[].blocks` 会被 Slack **静默丢弃**。

```bash
curl -s https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-raw '{
    "channel": "C01ABC123",
    "thread_ts": "1775307969.013919",
    "text": "fallback 摘要（不要传空格）",
    "blocks": [{"type":"section","text":{"type":"mrkdwn","text":"*详情*"}}],
    "unfurl_links": false,
    "unfurl_media": false
  }'
```

`thread_ts` 省略 = 发主消息，带上 = 发 thread reply。

### 更新消息

```bash
curl -s https://slack.com/api/chat.update \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-raw '{"channel":"C01ABC123","ts":"1775308000.100001","text":"更新内容","blocks":[...]}'
```

### 删除消息

```bash
curl -s https://slack.com/api/chat.delete \
  -d "channel=C01ABC123" -d "ts=1775308000.100001" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

### 定时发送

```bash
POST_AT=$(( $(date +%s) + 1800 ))   # 30 分钟后
curl -s https://slack.com/api/chat.scheduleMessage \
  -d "channel=C01ABC123" -d "text=定时消息" -d "post_at=$POST_AT" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
# 查待发队列：chat.scheduledMessages.list
# 取消：chat.deleteScheduledMessage -d "scheduled_message_id=Q12345"
```

### 取消息永久链接（ts → URL）

```bash
curl -s https://slack.com/api/chat.getPermalink \
  -d "channel=C01ABC123" \
  -d "message_ts=1775308000.100001" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
# 返回 {"ok":true,"permalink":"https://workspace.slack.com/archives/C01ABC/p..."}
```

---

## 添加 Reaction

```bash
curl -s https://slack.com/api/reactions.add \
  -d "channel=C01ABC123" \
  -d "timestamp=1775308000.100001" \
  -d "name=white_check_mark" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

`name` = 不带冒号的 emoji slug，如 `thumbsup` / `white_check_mark` / `x` / `eyes`。需要 `reactions:write` scope。

---

## 文件上传（v2 API）

旧 `files.upload` 已废弃。三步走：

**Step 1：申请上传 URL**

```bash
curl -s https://slack.com/api/files.getUploadURLExternal \
  -d "filename=report.pdf" \
  -d "length=$(wc -c < /path/to/file.pdf)" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
# 返回 upload_url + file_id
```

**Step 2：上传文件内容**

```bash
curl -s -X POST "$UPLOAD_URL" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/path/to/file.pdf
```

**Step 3：完成上传，关联到频道/thread**

```bash
curl -s https://slack.com/api/files.completeUploadExternal \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-raw '{
    "files": [{"id":"F08ABC123","title":"报告"}],
    "channel_id": "C01ABC123",
    "thread_ts": "1775307969.013919",
    "initial_comment": "附件请查收"
  }'
```

需要 `files:write` scope。

---

## 读取消息 / Thread

### Slack URL → Timestamp 转换

```
URL：https://workspace.slack.com/archives/C01ABC/p1775307969013919
去掉 p，倒数第 6 位插小数点 → 1775307969.013919
```

```bash
msg_id="1775307969013919"
ts="${msg_id:0:$((${#msg_id}-6))}.${msg_id: -6}"
```

```python
import re
def slack_url_to_ts(url):
    m = re.search(r'/p(\d+)', url)
    s = m.group(1)
    return f"{s[:-6]}.{s[-6:]}"
```

### 读 Thread

```bash
curl -s https://slack.com/api/conversations.replies \
  -d "channel=C01ABC123" \
  -d "ts=1775307969.013919" \
  -d "limit=50" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" | python3 -m json.tool
```

### 读频道历史（带时间过滤）

```bash
curl -s https://slack.com/api/conversations.history \
  -d "channel=C01ABC123" \
  -d "oldest=$(TZ=Asia/Tokyo date -v-1d +%s)" \
  -d "limit=100" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

**超 100 条需分页**：返回中有 `response_metadata.next_cursor`，再传 `-d "cursor=<value>"` 继续拉取，直到 `has_more: false`。

---

## 用户 / 频道查询

```bash
# token 状态自检
curl -s https://slack.com/api/auth.test -H "Authorization: Bearer $SLACK_BOT_TOKEN" | python3 -m json.tool

# 用户信息
curl -s https://slack.com/api/users.info -d "user=U01ABC123" -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# 频道信息
curl -s https://slack.com/api/conversations.info -d "channel=C01ABC123" -H "Authorization: Bearer $SLACK_BOT_TOKEN"

# 列全量频道（带分页，需多次 cursor）
curl -s https://slack.com/api/conversations.list \
  -d "limit=200" -d "types=public_channel,private_channel" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

---

## Block Kit 选型原则

| 场景 | 用什么 | 原因 |
|---|---|---|
| 信息类（反思/日报/巡检/digest） | top-level `blocks` | 展示稳定，无"空壳"风险 |
| 需要状态色条（告警/优先级） | `attachments[].blocks` + `color` | 唯一适合用颜色条的场景 |
| 正文 > 50 blocks | 拆成多条 thread reply | Slack 单消息 50 blocks 硬上限 |

段落结构靠 `header / section / divider / context`，不靠颜色。

---

## 用户反馈"只看到首行"时的恢复动作

1. 先 `conversations.replies` 回读，确认 Slack 落地了几条、每条 `text`/`blocks` 实际内容
2. 若截断：立即拆成 2-3 条短 thread reply 补发，标注 `补发 1/2` / `补发 2/2`
3. 补发后再回读验证 `blocks` 字段是否存在，不要只看 `ok:true`

---

## Gotchas

- **`source ~/Orb/.env` 炸 bash**：用 grep + cut 单独提取变量，见上方 Token 提取
- **form-encoded + `attachments[].blocks` 静默丢失**：改 `Content-Type: application/json` + top-level `blocks`
- **attachment-only reply 显示空壳**：`text` 传空格 + 内容全在 `attachments[].blocks` → 某些 Slack 视图渲染为空；改为 top-level `blocks` + 真实 `text` fallback
- **blocks > 50 → 降级为首行**：adapter 若有 `if blocks.length > 50: 只发 text fallback` 的逻辑会静默丢 blocks；改为拆多条
- **button `value` 超长 → `invalid_blocks`**：超 ~2000 chars 报错；改为 `value="file:<id>.json"`，payload 存本地文件
- **`invalid_arguments`**：别用 JSON body 调用不支持 JSON body 的接口；用 `-d "param=value"` form 格式
- **`ok:true` 不代表内容到位**：发完必须 `conversations.replies` 回读验证 `blocks`/`text` 是否真有内容
- **`reactions.add` 缺 scope**：返回 `missing_scope reactions:write`，需在 Slack App 配置里加
- **文件上传旧 API 废弃**：`files.upload` 已弃用；用 `getUploadURLExternal` → upload → `completeUploadExternal` 三步走
- **`reply_broadcast`**：默认不传；只有需要 reply 同时广播到频道时间线时才传 `true`
