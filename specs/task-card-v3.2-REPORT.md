# Task Card v3.2 Report

## 执行结果

已按 `profiles/karry/workspace/specs/task-card-v3.2-chunk-fix.md` 落地核心修复：

- `plan` 模式不再走 `plan_update` chunks
- `timeline` / `plan` 两种 `task_display_mode` 保留
- 所有 task card chunks 统一走 `task_update`
- 未 `git commit`
- 未重启任何 daemon / 进程

## 实际改动

本次只修改了 `src/scheduler.js`。

1. `src/scheduler.js:10`

- 移除 `buildPlanUpdateChunk` 的 import，避免继续走旧分支。

2. `src/scheduler.js:703-705`

- `buildTaskCardChunks()` 由按 `chunkType` 分流：
  - `task -> buildTaskUpdateChunks(...)`
  - `plan -> buildPlanUpdateChunk(...)`
- 改为统一：
  - `return buildTaskUpdateChunks(taskCardState.taskCards);`

3. `src/scheduler.js:715-718`

- `startStream(...).initial_chunks` 继续调用 `buildTaskCardChunks()`。
- 由于上面的统一分派，`plan` 模式启动时也会发送 `task_update` chunks。

4. `src/scheduler.js:730-733`

- `appendStream(...)` 继续调用 `buildTaskCardChunks()`。
- 现在 `plan` 模式增量更新同样发送 `task_update` chunks。

5. `src/scheduler.js:768-779`

- `stopTaskCardStream()` 的 `stopPayload` 原先只在 `chunkType === 'task'` 时携带 `chunks`。
- 现在改为无条件携带：
  - `chunks: buildTaskCardChunks()`

6. `src/scheduler.js:821-842`

- deferred task card 路径里，`startStream(...).initial_chunks` 与最终 `stopPayload.chunks` 同样统一走 `buildTaskCardChunks()`。
- 避免 plan 模式在 deferred/plan 路径又退回不带 chunks 的旧行为。

## 保留项

`src/adapters/slack-format.js` 本次未改。

- `buildPlanUpdateChunk` 仍保留，当前位置是 `src/adapters/slack-format.js:596-604`
- 当前代码搜索结果显示它已不再被 `src/scheduler.js` 调用
- `chunkType` / `displayMode` 采集逻辑保留，只继续用于 `task_display_mode` 选择，不再控制 chunk 构造

## 自测

已完成：

- `node --check src/scheduler.js`
- `node --check src/adapters/slack-format.js`
- 代码搜索确认 `scheduler.js` 中 task card 发送点如下，均已统一到 `buildTaskCardChunks()`：
  - `initial_chunks` at `src/scheduler.js:717`
  - `appendStream(...)` at `src/scheduler.js:733`
  - `stopTaskCardStream().chunks` at `src/scheduler.js:775`
  - deferred `initial_chunks` at `src/scheduler.js:833`
  - deferred `stopPayload.chunks` at `src/scheduler.js:838`

未完成：

- 未做真实 Slack 线上回归，因此验收项 1/2/3 目前是代码路径满足，非实流量验证

## 结论

v3.2 所需核心修复已完成：`plan` 展示模式仍保留，但 chunk 层统一回退到 `task_update`，不会再用 `plan_update` 替代。
