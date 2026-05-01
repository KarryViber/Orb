---
name: slack-block-action-handlers
description: Slack 按钮点击 (block_action) 的确定性路由协议——新建审批卡按钮时必须在 `profiles/<your-profile>/scripts/handlers/` 下放同名 handler 脚本，adapter 按 action_id 直接执行（零 LLM、零 worker fork）。Use when 需要新建带按钮的 Slack 卡片、修改 handler 脚本、或排查按钮点击无响应。
provenance: user-authored
---

# Slack block_action Handlers

> 🚧 **待 adapter 实现** — 本 skill 描述目标协议（见 `specs/slack-block-action-handlers.md`）。当前 `src/adapters/slack.js:865` 仍静默丢弃 block_action，按钮点击不会触发 handler。spec 落地后本标记移除。

外部脚本（cron / Python / Node）自推的审批卡按钮被点击后，Slack 回传 block_action 事件。Orb adapter 做**确定性路由**——按 `action_id` 找同名 handler 脚本执行，**不走 LLM，不 fork worker**。

## 发现规则

```
profiles/{profile}/scripts/handlers/{action_id}.{py,sh,js}
```

- `action_id` 必须匹配正则 `^[a-z][a-z0-9_]{0,63}$`（snake_case，防路径穿越）
- 扩展名查找顺序：`.py` → `.sh` → `.js`
- **未找到 handler** → adapter chat.update 成 `⚠️ 未注册 handler: {action_id}` 并 @Karry

## 现有 handlers（04-21）

```
orb_x_post_approve.py     — X 拟稿审批通过 → 发推
orb_x_post_reject.py      — X 拟稿拒绝
orb_x_reply_approve.py    — X 回复审批通过
orb_x_reply_reject.py     — X 回复拒绝
```

新增按钮前先看有没有可复用的 action_id 命名。

## Handler 接口（stdin JSON）

adapter spawn handler 时通过 **stdin 单行 JSON** 传 context（避免 env 长度限制和 argv 注入）：

```json
{
  "action_id": "orb_x_post_approve",
  "value": "<button value 原样透传，可能是 base64 payload>",
  "user_id": "U0AN7112XD2",
  "channel": "C0AP013V056",
  "message_ts": "1776702715.774950",
  "thread_ts": "1776702715.774949",
  "profile": "karry",
  "response_url": "<Slack response_url>"
}
```

handler 模板（Python）：

```python
#!/usr/bin/env python3
import sys, json, os

ctx = json.loads(sys.stdin.read())
action = ctx["action_id"]
value = ctx["value"]
channel = ctx["channel"]
message_ts = ctx["message_ts"]

# 业务逻辑...

# 自己 chat.update 最终态（Slack Web API 或 response_url）
# adapter 不会替你改卡面！
```

## 生命周期（重点）

**adapter 不持有 handler 进程**。流程：

1. Adapter 收到 block_action，ack Slack
2. Adapter chat.update 原卡为 `⏳ 处理中… <@{user}> clicked \`{action_id}\``（禁用按钮，防重复点）
3. Adapter spawn handler，**detach + unref**（不 wait、不超时、不 kill）
4. Adapter 记 `logs/handlers/pids.log` 一行：`{ts} pid={pid} action_id={id} message_ts={ts}`
5. Handler 自己跑完业务，**自己 chat.update 最终态**（用 response_url 或 Slack Web API token）

## Handler 自律清单（必做）

- [ ] 读 stdin 拿 context
- [ ] 执行业务
- [ ] **chat.update 最终态**（成功/失败/跳过都要更新，否则卡面永远显示 ⏳）
- [ ] 业务自带超时（发推 10s / LLM 生成 60s），超时内部自己写 `❌ 超时` + exit
- [ ] stdout 日志 adapter 捕获到 `logs/handlers/{action_id}-{ts}.log`

## 并发去重

adapter 维护 `Set<message_ts>`：
- 点击时 message_ts 已在集合里 → 仅 ack，不再 spawn
- 释放条件：chat.update 已变成非 `⏳ 处理中` 状态（handler 通过 update 隐式宣告完成）
- 兜底：10min 定时清理

## 安全边界

- handler 路径硬限 `profiles/{profile}/scripts/handlers/`，`..` / 绝对路径被拒
- 执行用户同 daemon（没有额外 sandbox）
- `action_id` 白名单正则已覆盖大部分注入面
- `value` 字段 adapter 不解析，原样透传给 handler——**handler 自己验证 payload**（别信 value）

## Gotchas

1. **handler 漏写 chat.update** → 卡面永远 ⏳（不是 adapter bug，是脚本 bug）。模板必带 try/except + finally chat.update
2. **button value 超 2000 字** 会被 Slack 截断。payload 太大就存文件，value 只放引用 id
3. **action_id 命名** 要能表达「什么操作 + 什么对象」（好：`orb_x_post_approve`；坏：`btn1`）
4. **adapter 不重试**。handler crash = 卡面永远 ⏳，Karry 手动点醒或查 `logs/handlers/`
5. **新 handler 首次上线** 在 DM 先跑一张测试卡，别直接在对外频道首发
6. **Python handler 缺依赖** spawn 时 silent 失败（stderr 进 log 文件，卡面不变）；新增前先 `python3 handlers/foo.py < test.json` 跑一次

## 新建按钮的完整工作流

1. 想好 action_id（snake_case，表达「操作+对象」）
2. 复制最像的 existing handler 作模板
3. 本地 dry-run：构造 test.json → `python3 handlers/{new_id}.py < test.json`，验证能 chat.update
4. 在生成卡片的脚本里新增按钮：
   ```python
   {"type": "button", "text": {"type": "plain_text", "text": "✅ Approve"}, "action_id": "new_action_id", "value": "..."}
   ```
5. DM 先测，验证 adapter 路由 + handler chat.update 都走通
6. 推到对外频道
