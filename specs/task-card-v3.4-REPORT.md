# Task Card v3.4 Report

## 执行结果

- 已按 `profiles/karry/workspace/specs/task-card-v3.4-audit-cleanup.md` 完成 Part A / Part B / Part C。
- 未执行 `git commit`。
- 未重启 daemon。

## Part A — 恢复 details / output

- [src/worker.js](/Users/karry/Orb/src/worker.js:29) 同步了 IPC 注释，恢复 `tool_call.details` 与 `tool_result.output` schema。
- [src/worker.js](/Users/karry/Orb/src/worker.js:299) 保留并使用 `truncate256()`，与任务卡要求的 256 字段上限对齐。
- [src/worker.js](/Users/karry/Orb/src/worker.js:580) `tool_call` payload 恢复 `details: truncate256(summarizeToolDetails(...))`。
- [src/worker.js](/Users/karry/Orb/src/worker.js:603) `tool_result` payload 恢复 `output: truncate256(extractToolResultText(...))`。
- [src/adapters/slack-format.js](/Users/karry/Orb/src/adapters/slack-format.js:560) `buildTaskUpdateChunks()` 恢复 `details` / `output` 透传，并保持 256 截断。

## Part B — 死代码清理

- [src/worker.js](/Users/karry/Orb/src/worker.js:415) 删除 `buildPlanLockedTodoWriteTitle()`；TodoWrite 不再走 plan-lock 降级标题分支。
- [src/worker.js](/Users/karry/Orb/src/worker.js:584) TodoWrite 与混合 turn 统一走 `buildToolTitle()`，满足“不要再出现 `📋 TodoWrite: N tasks` 降级标题”。
- [src/adapters/slack-format.js](/Users/karry/Orb/src/adapters/slack-format.js:554) 删除零引用的 `buildPlanBlock()`。
- [src/adapters/slack-format.js](/Users/karry/Orb/src/adapters/slack-format.js:560) 删除零引用的 `buildPlanUpdateChunk()`。
- [src/scheduler.js](/Users/karry/Orb/src/scheduler.js:80) `resolveTaskCardDisplayMode()` 简化为仅保留 timeline 解析，fallback 默认改为 `'timeline'`。
- [src/scheduler.js](/Users/karry/Orb/src/scheduler.js:85) 保留 `buildTaskCardFallbackMarkdown()` 的 details 分支；Part A 恢复后该降级路径重新有效。
- [src/scheduler.js](/Users/karry/Orb/src/scheduler.js:715) live stream 打开时 fallback 已从 `'plan'` 改为 `'timeline'`。
- [src/scheduler.js](/Users/karry/Orb/src/scheduler.js:831) deferred stream 打开时 fallback 已从 `'plan'` 改为 `'timeline'`。
- [src/adapters/slack.js](/Users/karry/Orb/src/adapters/slack.js:1274) 删除 `normalizedTaskDisplayMode === 'plan'` 时注入 `plan_update` 的死分支；`startStream()` 仅发送已有 `task_update` chunks。

## Part C — 文档同步

- [CLAUDE.md](/Users/karry/Orb/CLAUDE.md:157) IPC 表保留 `tool_call.details` / `tool_result.output` 描述。
- [CLAUDE.md](/Users/karry/Orb/CLAUDE.md:164) Task Card Routing 改为：`display_mode` 自 v3.3 起始终为 `'timeline'`，`chunk_type` 仅保留语义。
- [CLAUDE.md](/Users/karry/Orb/CLAUDE.md:172) Task Card Lifecycle 删除旧的 plan-mode 终态描述，统一为 `stopStream` 携带 final chunks + `markdown_text` + `blocks`。

## 验证

- `node --check src/worker.js`
- `node --check src/scheduler.js`
- `node --check src/adapters/slack.js`
- `node --check src/adapters/slack-format.js`
- `rg -n "buildPlanUpdateChunk" src/` 无命中
- `rg -n "display_mode='plan'|plan mode" CLAUDE.md` 无命中
