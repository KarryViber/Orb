# Spec: typing 基于 CLI idle 检测

## 上一轮修复的过度问题
`turn_complete` 一条用户消息可能触发多次（CLI 的 `result` 事件会多次出现，每次 tool-use 往返就可能有一个），我们一收到就 stopTyping，导致长任务处理中途 typing 消失。

## 正确模型
- `turn_complete` 仅用于送达中间/最终文本，**不**动 typing
- worker 侧维护一个 CLI 活动监测：CLI 的 stdout（handleStreamMsg 所有分支）持续视为活动，最后一次活动后静默 2000ms 发一次 IPC `idle`
- scheduler 收到 `idle` → `stopTyping()`
- 若后续 CLI 又有活动（新 turn_complete 或 tool_use），worker 发 `busy` IPC，scheduler `startTyping()` 重启 typing
- `inject` 路径已有 `startTyping()`，保持不变
- `result` / `error` / `onExit` / fork 失败的 `stopTyping()` 全部保留

## 改动

### `src/worker.js`
在 `runClaudeInteractive` 里：
- 新增 `let lastActivityAt = 0; let idleNotified = false; let activityTimer = null; let onActivity = null;`
- `handleStreamMsg` 入口（在分发前）调一次 `markActivity()`
- `markActivity()`：
  ```js
  lastActivityAt = Date.now();
  if (idleNotified) {
    idleNotified = false;
    if (onActivity) onActivity('busy');
  }
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    idleNotified = true;
    if (onActivity) onActivity('idle');
  }, 2000);
  ```
- 导出 `setOnActivity: (fn) => { onActivity = fn; }`
- close/exit 时 `if (activityTimer) clearTimeout(activityTimer);`

在 `worker.js` 主流程（约 144 行附近）注册：
```js
cli.setOnActivity(async (state) => {
  await ipcSend({ type: state }); // 'idle' or 'busy'
});
```

### `src/scheduler.js`
- 移除 `turn_complete` 分支里的 `await stopTyping();`（回滚上轮这一句）
- 在 `onMessage` 里加：
  ```js
  if (msg.type === 'idle') { await stopTyping(); return; }
  if (msg.type === 'busy') { await startTyping(); return; }
  ```
- 其他分支（result/error/onExit/fork 失败）保留 `stopTyping()`

### IPC 协议文档
worker.js 顶部注释里补充两条新 IPC 类型：`idle` / `busy`，无 payload。

## 验收
1. 单次长任务（Claude 多次 tool-use 持续 30s+）：typing 全程保持，只在最终结束后消失 —— 容忍中间有 ≤2s 的短暂消失（idle 阈值）但不应频繁
2. 短回答（<2s）：typing 出现 → 回复到 → typing 消失（可能由 idle 触发，也可能由 result/onExit 触发，任一即可）
3. Follow-up inject 进来：typing 立刻重新出现
4. 出错 / worker 退出：typing 清零

## 不要改
- `adapters/slack.js` 不动
- `turn_complete` 的送达逻辑不动（只移除 stopTyping 调用）
- 不引入新的 activeWorkers 结构变更（上轮的 `{worker, startTyping, stopTyping}` 封装继续用）
