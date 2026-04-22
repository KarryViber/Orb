# Task Card v3.3 Report

## 范围

- 按 `profiles/karry/workspace/specs/task-card-v3.3-timeline-slim.md` 执行
- 仅修改 `src/worker.js` 和 `src/adapters/slack-format.js`
- 未 `git commit`
- 未重启 daemon / 进程

## 改动

### 1. `display_mode` 统一为 `timeline`

- 文件: `src/worker.js`
- 位置:
  - [src/worker.js](/Users/karry/Orb/src/worker.js:522)
  - [src/worker.js](/Users/karry/Orb/src/worker.js:528)
  - [src/worker.js](/Users/karry/Orb/src/worker.js:576)
- 处理:
  - turn 内 task-card 的默认 `taskCardDisplayMode` 从 `plan` 改为 `timeline`
  - `resetTurnStreamingState()` 的默认值同步改为 `timeline`
  - 首个 task-card tool 出现时，不再根据 `chunk_type` 在 `timeline/plan` 间切换，而是无条件发 `display_mode='timeline'`
- 保留:
  - `taskCardChunkType` 仍保留 `task/plan` 两档
  - 混合 turn 下 plan-locked `TodoWrite` 的标题降级逻辑仍保留

### 2. `tool_call` 不再携带 `details`

- 文件: `src/worker.js`
- 位置:
  - [src/worker.js](/Users/karry/Orb/src/worker.js:589)
  - 协议注释同步更新于 [src/worker.js](/Users/karry/Orb/src/worker.js:29)
- 处理:
  - `tool_call` IPC payload 去掉 `details`
  - 现在只发送 `type/task_id/tool_name/title/chunk_type/display_mode?`

### 3. `tool_result` 不再携带 `output`

- 文件: `src/worker.js`
- 位置:
  - [src/worker.js](/Users/karry/Orb/src/worker.js:614)
  - 协议注释同步更新于 [src/worker.js](/Users/karry/Orb/src/worker.js:31)
- 处理:
  - `tool_result` IPC payload 去掉 `output`
  - 现在只发送 `type/task_id/status`

### 4. `task_update` chunk 精简为 `title + status`

- 文件: `src/adapters/slack-format.js`
- 位置: [src/adapters/slack-format.js](/Users/karry/Orb/src/adapters/slack-format.js:580)
- 处理:
  - `buildTaskUpdateChunks()` 去掉 `details/output`
  - 当前返回结构固定为:

```js
{ type: 'task_update', id, title, status }
```

### 5. `buildPlanUpdateChunk` 保留但不参与 v3.3 路径

- 文件: `src/adapters/slack-format.js`
- 位置: [src/adapters/slack-format.js](/Users/karry/Orb/src/adapters/slack-format.js:591)
- 处理:
  - 函数保持不动，作为保留实现
  - 当前 scheduler 仍按 v3.2 路径统一调用 `buildTaskUpdateChunks()`

## 自测

- 已执行:
  - `node --check src/worker.js`
  - `node --check src/adapters/slack-format.js`
- 结果:
  - 两个文件语法检查通过

## 验收对照

1. 非 TodoWrite 多工具 turn:
   - 代码路径满足。首个 task-card tool 也会以 `display_mode='timeline'` 建流，chunk 仅保留单行 `task_update`
2. TodoWrite turn:
   - 代码路径满足。`TodoWrite` 仍走 `timeline`
3. 混合 turn:
   - 代码路径满足。首工具若锁为 `plan`，后续 `TodoWrite` 仍保留 v3.1 的 `📋 TodoWrite: N tasks` 单行标题降级
4. 占屏 ≤ 工具数量行数:
   - 代码路径满足。worker IPC 与 Slack chunk 构造都已移除 `details/output`

## 未执行

- 未做真实 Slack 线上回归
- 未重启 daemon

