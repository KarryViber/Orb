# DM 路由在 Slack AI Assistant 模式下失效 — 修复 spec

**owner**: external session
**scope**: `src/adapters/slack.js`（可能少量 `src/scheduler.js`）
**priority**: P0 — adapter v2 前置路由 100% 不触发，全部 DM 压回 agent 侧软路由

---

## 问题

Slack DM (`D0ANGB3M1CZ`) 改用 AI Assistant app 模式后，每条入站消息都自动落在一个 Assistant Thread 里（thread_ts 指向 bot 创建的 "New Assistant Thread" 根消息）。

`src/adapters/slack.js:1679` 现有门禁：

```js
if (isDM && channelType === 'im' && !event.thread_ts && this._dmRouting?.enabled) {
```

`!event.thread_ts` 条件把**所有** Assistant DM 消息排除在路由之外 → `_routeDMMessage` 永不被调用 → adapter 不建目标频道主卡片、不 fork 目标频道 worker。所有 DM fall through 到普通 worker 路径，路由逻辑靠 agent 侧软路由（v1 fallback）兜底，结果：

1. **路由质量退化**：目标频道（#08-evolution / #10-x-ops / #04-finance）的新 thread 里没有 worker 监听，Karry 在 thread 里追加的跟进消息（如「可接近的点帮我落一下地吧」）无人接应
2. **静默契约破坏**：DM 侧 worker 跑完路由动作静默结束时，`scheduler.js:1136` 的 auto-continue fallback 往 DM 喷「⏳ 回合上限已达…」提示

### 复现

1. 向 bot DM 发送 `https://github.com/forrestchang/andrej-karpathy-skills`
2. 观察：
   - `#08-evolution` 无 adapter 预建的「🧬 GitHub MM/DD｜{repo_slug}｜待调研」主消息
   - DM 里出现「このメッセージにはインタラクティブ要素が含まれます」（渲染成占位的 auto-continue 卡片）
3. 期望：adapter 前置路由触发 → 目标频道建主卡片 → worker 在目标 thread 上下文里跑 `workerPrompt`；DM 侧完全无输出

---

## 修复要求

### P0-1：放宽路由门禁，穿透 Assistant Thread

目标：Assistant DM 里的用户入站消息（非 bot 自身的 "New Assistant Thread" 占位）能触发 `_routeDMMessage`。

**识别 Assistant Thread 的方法（优先级降序）**：

1. `event.assistant_thread` 字段（若 Slack SDK 带）
2. `event.channel_type === 'im'` + `event.thread_ts === event.ts`（首条用户消息，thread 就是它自己）——**不适用**，因为 Assistant Thread 里 thread_ts 指向 bot 的根
3. `event.channel_type === 'im'` + thread 根消息是 bot 自己发的 "New Assistant Thread" 占位——需要 `conversations.replies` 查根消息 subtype / text / bot_id
4. 最简单启发式：`channel_type === 'im'` + `event.user` 是真人（非 bot_id）+ thread_ts 存在但非 bot 跟踪的 thread → 认定 Assistant Thread

建议实现：

```js
const isAssistantThread = isDM
  && channelType === 'im'
  && event.thread_ts
  && !this._isBotThread(event.thread_ts)  // 非 orb worker thread
  && !event.bot_id;                        // 真人入站

if (isDM && channelType === 'im' && (!event.thread_ts || isAssistantThread) && this._dmRouting?.enabled) {
  const outcome = await this._routeDMMessage(event);
  ...
}
```

要点：
- 必须排除 bot 在 DM 里自己建的 worker thread（否则 agent 回复也会触发路由 → 死循环）
- 必须排除用户在**已路由 thread** 里的追问（进入 thread 后应走正常 worker 路径，不再次路由）——`_isBotThread` 已跟踪 `_trackThread` 过的 ts，能覆盖

### P0-2：Assistant Thread 根消息识别兜底（可选加固）

如果 `_isBotThread` 对 Assistant Thread 根不生效（因为根是 Slack 服务器插入，不走我方 `chat.postMessage`），补一个 `conversations.replies` 查根消息：

```js
async _isAssistantThreadRoot(channel, thread_ts) {
  try {
    const resp = await this._slack.conversations.replies({ channel, ts: thread_ts, limit: 1 });
    const root = resp.messages?.[0];
    return root?.bot_id === this._botId && /Assistant Thread/i.test(root?.text || '');
  } catch { return false; }
}
```

调用点：`_handleMessage` 路由判定前缓存（per thread_ts）。

### P1：auto-continue DM 静默契约

修 `src/scheduler.js:1136` 附近的 auto-continue 提示，避免在 DM 路由场景下破坏静默：

**方案 A**（首选）：worker task payload 增加 `silentOnEmpty: true` 字段；`_routeDMMessage` fork worker 时不涉及（因为路由 worker 在目标频道不在 DM，不会触发 DM 静默问题）；**真正需要的是** agent 软路由兜底场景——当 worker 跑完 turn 无 text + 有 tool_use 副作用时，检查 channel 是否为 DM + 最近一次 tool_use 是否向其他 channel postMessage，若是则跳过 auto-continue 提示。

**方案 B**（简单）：auto-continue 提示改成发 `chat.postMessage` 前检查 `event.subtype`/`channel_type`，DM 场景降噪为 `console.log` 不发 Slack 消息。

选任一实现即可，不要两个都做。

---

## 验证

1. **GitHub 路由**：DM 发 `https://github.com/anthropics/claude-code`
   - 期望：#08-evolution 出现「🧬 GitHub MM/DD｜anthropics/claude-code｜待调研」主消息 + thread 里出现 Block Kit 调研卡
   - 期望：DM 侧完全无回复
2. **X 路由**：DM 发任一 `https://x.com/*/status/*`
   - 期望：#10-x-ops 出现「🐦 X 拟稿 MM/DD」主消息 + thread 里出现审批卡
   - 期望：DM 侧完全无回复
3. **PDF invoice 路由**：DM 上传一个 invoice PDF
   - 期望：#04-finance 出现记账主消息 + thread 里出现 dry-run payload
4. **Thread 追问不重复路由**：在 #08-evolution 已路由的 thread 里 Karry 回复「展开说说」
   - 期望：走正常 worker 路径，在同 thread 里回复，不再次建新 thread
5. **回归：DM 直接对话**：DM 发「帮我看下 cron 任务」（无链接、无附件）
   - 期望：正常 worker 路径回复到 DM（Assistant Thread 里）

---

## 禁止事项

- 不要改 worker IPC 协议
- 不要改 `src/main.js` / `start.sh` / `package.json`
- 不要动 `config.json` 的 `dmRouting` 规则结构
- 改完**必须重启 daemon**（`launchctl kickstart -k gui/$UID/com.karry.orb` 或等用户手动）才能生效；单纯 SIGHUP 不够

---

## 背景参考

- `.claude/skills/dm-routing/SKILL.md` — v1 协议（agent 侧软路由，现在是实际跑的路径）
- `specs/dm-routing-v2-adapter.md` — v2 adapter 路由原始设计（已存在于 git 历史）
- `specs/dm-routing-v2.1-cards.md` — 目标频道 Block Kit 卡片规范
- `config.json` 的 `adapters.slack.dmRouting` — 当前三条规则（x-reply-drafting / github-research / invoice-bookkeeping）
