# Long-Task Visibility — 长任务进度可见性改造

**目标**：消除 Orb 执行长任务（>30s）时 Karry 端的"黑盒感"。让用户从"Orb 是不是死了 / 做到哪了"的焦虑，变成"进度清晰可见"。

**触发场景**：40+ 次 tool call 的 PPT 改造、多文件重构、需要 unpack/pack/QA 渲染的文档工作流。

---

## 痛点（2026-04-20 事件）

`JP 销售材料更新` thread（`1776653959.800729`）：
- Orb 跑 ~5 分钟完成 2 页 PPT 改造（40+ Edit + unpack + pack + QA）
- Karry 侧感知：typing indicator 时有时无 → 4 次追问"还在吗 / 好了吗"
- 直到最后一条消息才知道结果

本质：**worker 内部忙，但 Slack 侧无心跳 + 无中间状态**。

---

## 三层改造（按优先级排序）

### ① 进度可视化（最高 ROI）

**机制**：拦截 Claude CLI stream 里的 `TodoWrite` tool_use 事件，在 thread 里维护一条**进度消息**，每次 todo 状态变化调用 `adapter.editMessage()` 原地更新。

**展示格式**（例）：
```
📋 任务进度
✅ unpack PPTX
✅ 修改 slide34（ymfg）
🔄 修改 slide35（Toyota）
⬜ pack + QA
```

**实现要点**：
- `worker.js` 在 stream-json 里识别 `tool_use` 事件 name=`TodoWrite`
- 首次出现时调用 `adapter.sendReply()` 拿到 `ts`，记到 worker local state
- 后续每次 TodoWrite 调用 `adapter.editMessage(ts, 新内容)`
- todos 渲染成 checkbox 列表（emoji: ✅/🔄/⬜）
- 可选：末尾 append 当前 `lastTool` 一行，更细颗粒

**涉及文件**：
- `src/worker.js`（stream parser 里 hook TodoWrite）
- `src/adapters/slack.js`（`editMessage` 已存在，若参数需要补齐则补）
- `src/scheduler.js`（透传 progress 事件或让 worker 直接调 adapter）

**验收**：跑一个 ≥5 todos 的任务，thread 里出现 1 条消息 + 每次 todo 状态变化该消息被编辑更新，不新建消息。

---

### ② Typing 心跳

**机制**：worker fork 时启动一个 `setInterval(8s)` 的 heartbeat，只要 Claude CLI 进程还在跑，就持续调 `adapter.setTyping(channel, threadTs)`。进程退出 / 收到 `turn_complete` / `result` 时清掉 interval。

**背景**：Slack 的 typing indicator TTL 是 ~5s，当前 Orb 只在收到消息瞬间设 typing，tool call 期间就过期了。

**实现要点**：
- `src/worker.js` 入口处 `setInterval`
- 清理点：`result` / `error` / `turn_complete`（若 worker 继续待机等 inject，心跳也可暂停）
- 8s 间隔（低于 Slack 10s 刷新周期，高于每秒刷减噪音）

**涉及文件**：
- `src/worker.js`
- `src/adapters/slack.js`（`setTyping` 已存在）

**验收**：跑一个 3 分钟的任务，整个期间 Slack 侧 typing indicator 持续显示不中断。

---

### ③ 中间 assistant text 流式投递

**机制**：Claude CLI stream-json 模式会在每轮 tool_use 之间吐 `assistant` 消息（含 text block）。当前 Orb 只在 `turn_complete` / `result` 时投递最终文本。改造为：遇到中间 `text` block 立即 `adapter.sendReply()` 到 thread。

**好处**：Orb 的中间思考（"切到 B 方案"、"现在保留笔电 mockup"）原生出现在 thread，不用手写 progress。

**实现要点**：
- `src/worker.js` stream parser 识别 `event.type === 'content_block_delta' | 'content_block_start'` 里的 text
- 聚合整个 text block（流式拼接直到 `content_block_stop`）再投递，避免一个字一个字发
- 需要节流：同一 turn 内多个 text block 间隔 <2s 的合并为一条
- `turn_complete` 时不重复投递已经发过的中间文字

**涉及文件**：
- `src/worker.js`
- `src/context.js` 可能需要新增一个 "intermediate text 已投递列表" state

**验收**：跑一个 Claude 明显分段思考的任务（"先分析 X → 然后处理 Y → 最后 QA Z"），thread 里分别出现 3 条中间消息 + 1 条最终消息，而不是 1 条堆叠。

---

## 交付顺序建议

1. 先做 **①（进度条）**：独立、可见度最高、能立刻解决 80% 体感问题
2. 然后 **②（typing 心跳）**：纯 UX 补丁，代码极少
3. 最后 **③（中间文字流）**：最复杂，涉及 stream 事件模型改造，需验证不会影响 `inject` follow-up 场景

每个阶段独立验收、独立 commit，不要 bundled PR。

---

## 非目标

- 不做 Slack Block Kit 花哨可视化（进度条就用 emoji list，别整 progress bar 动画）
- 不做跨 thread 进度聚合（每个 thread 的进度消息独立）
- 不动 CLI stream 协议本身（只读 stream，不改 Claude CLI 行为）

---

## 相关约束（参考 `~/Orb/CLAUDE.md`）

- Workers 是 short-lived per-thread 进程：进度消息的 ts 存在 worker local state，worker exit 即丢弃（不持久化，下一个 inject 要么复用要么重建）
- 新增 IPC message type 需同步更新 `worker.js` header + `scheduler.js` handler + CLAUDE.md § Worker IPC Protocol
- 配置变更后必须验证运行时状态（不只是文件保存）
