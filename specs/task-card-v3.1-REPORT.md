# Task Card v3.1 Report

## 范围

- 按 `profiles/karry/workspace/specs/task-card-v3.1-bugfix.md` 执行
- 仅修改 `src/worker.js` 和 `src/scheduler.js`
- 未 `git commit`
- 未重启 daemon

## 改动

### 1. 混合 turn 锁模式

- 文件: `src/worker.js`
- 位置:
  - `buildPlanLockedTodoWriteTitle()` 在 415-418 行
  - `handleStreamMsg()` 中混合 turn 改写 title 在 584-599 行
- 处理:
  - 当当前 turn 的 task-card 已被非 `TodoWrite` 工具锁为 `chunk_type='plan'` 后，后续 `TodoWrite` 不切换模式
  - 该 `TodoWrite` 的 `tool_call.title` 改写为 `📋 TodoWrite: N tasks`
  - 保持原有 `chunk_type='plan'` / `display_mode`，不额外触发 timeline
- tradeoff:
  - 这是 title 层面的降级，不会把同 turn 后续 `TodoWrite` 强行提升成 task timeline，优先保证 stream 结构一致

### 2. graceful 降级不再丢 task-card 内容

- 文件: `src/scheduler.js`
- 位置:
  - `buildTaskCardFallbackMarkdown()` 在 86-99 行
  - `failTaskCardStream()` 调整在 666-687 行
- 处理:
  - 继续使用已有 `classifyTaskCardStreamError()`
  - 对 `message_not_in_streaming_state` / `message_not_owned_by_app` 这类 graceful 错误，先把 `taskCardState.taskCards` 渲染为普通 markdown 消息再清空状态
  - markdown 为每 task 一行，状态映射为 `⏳` / `✅` / `❌`
  - `invalid_chunks` / `invalid_auth` 仍按错误路径处理，不做普通消息降级
- tradeoff:
  - 降级消息只保留 task title 和 details，不复刻 Slack stream 的完整结构；目标是保住轨迹，避免静默丢失

### 3. Task tool title

- 文件: `src/worker.js`
- 位置: `buildToolTitle()` 438-440 行
- 处理:
  - 为 `toolName === 'Task'` 增加专门分支
  - title 现在优先显示 `Agent: <description>`，fallback 为 `sub-agent`
- tradeoff:
  - 仅修 `Task`，没有改动现有 `Agent` 分支语义，避免扩大 UI 变更面

## 自测

- 已执行:
  - `node --check src/worker.js`
  - `node --check src/scheduler.js`
- 结果:
  - 两个文件语法检查通过

## 未执行

- 未重启 daemon
- 未做线上 Slack 手工验证
- 未人为制造 stream failure 做集成演练；当前结论基于代码路径审查与语法校验

