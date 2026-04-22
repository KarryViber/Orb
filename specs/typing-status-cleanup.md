# Spec: Slack typing 状态回答完不清除

## 现象
每次 Orb 回答完后，Slack 的 `is thinking…` typing 状态继续显示到 worker idle 超时退出才消失。系统性问题，非个例。

## 根因
`src/scheduler.js` 里 typing 的生命周期与 worker 绑定：
- 第 180-189 行：spawn 时 `setTyping('is thinking…')` + 每 5s interval 刷新
- 第 331-334 行：只在 `onExit` 里 `clearInterval` + `setTyping('')`

但 worker 复用架构下，`turn_complete`（第 240 行）发送回复后 worker 不退出，typing interval 继续每 5s 刷新，用户持续看到 typing 状态。

另外 inject 路径（第 97 行）只调一次 `setTyping`，没重启 interval——follow-up 消息处理中 typing 会在 ~5s 后自动消失。

## 修复

**文件**：`src/scheduler.js` 唯一

### 1. 把 typing 控制抽成可重启的句柄

在 `_spawnWorker` 顶部（现在 `let typingSet = false` 附近，~180 行）替换成：

```js
let typingInterval = null;
const startTyping = async () => {
  if (typingInterval) return;
  try { await adapter.setTyping(channel, threadTs, 'is thinking…'); } catch (_) {}
  typingInterval = setInterval(async () => {
    try { await adapter.setTyping(channel, threadTs, 'is thinking…'); } catch (_) {}
  }, 5_000);
};
const stopTyping = async () => {
  if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
  try { await adapter.setTyping(channel, threadTs, ''); } catch (_) {}
};
await startTyping();
```

删除原来的 `typingSet` / `typingInterval = setInterval(...)` 初始化块。

### 2. `turn_complete` 分支发完回复后 stopTyping

第 240 行 `if (msg.type === 'turn_complete')` 分支，发完 payloads 后调用 `await stopTyping();`（在 `return` 之前）。

### 3. `result` / `error` 分支也 stopTyping

第 316 行 `msg.type === 'error'` 分支：发 warn 前 `await stopTyping()`。
`result` 分支（发最终回复处）同样加 `await stopTyping()`。

### 4. `onExit` 简化

第 331-334 行改为 `await stopTyping();`（幂等，已停就 no-op）。

### 5. inject 路径重启 typing

第 92-105 行 inject 分支：`activeWorkers` map 目前只存 worker 进程，需要扩展为 `{ worker, startTyping, stopTyping }` 以便 inject 时调 `startTyping()`。

最简改法：把 `activeWorkers.set(threadTs, worker)`（~369 行）改成 `activeWorkers.set(threadTs, { worker, startTyping, stopTyping })`，全局访问处相应改 `.worker`。inject 路径第 95-97 行改为：

```js
const entry = this.activeWorkers.get(threadTs);
entry.worker.send({ type: 'inject', ... });
await entry.startTyping();
```

检查所有 `activeWorkers.get/has/delete` 调用点（grep 一下），确保取 worker 进程对象处都加 `.worker`。

### 6. fork 失败路径

第 361-366 行 `catch` 里 `clearInterval(typingInterval)` 和 `cleanupIndicator` 需要同步改为调 `stopTyping()`（cleanupIndicator 内部仍发 warning 消息的部分保留）。

## 验收
1. Slack 发一条消息 → typing 出现 → 回复送达 → typing **立即消失**
2. 同一 thread 再发一条 follow-up → typing 重新出现 → 回复送达 → 再消失
3. Worker idle 超时退出时不报错、typing 已是空态
4. 出错路径（`error` / fork 失败 / worker 无响应退出）typing 也清零

## 不要做
- 不要改 `adapters/slack.js`，`setTyping` 接口本身没问题
- 不要改 IPC 协议（`turn_complete` / `inject` / `result` / `error` 语义不变）
- 不要改 worker idle timeout 逻辑
