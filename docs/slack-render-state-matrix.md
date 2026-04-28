# Slack 渲染层状态矩阵

## 出口清单（5 个）

| 出口 | 持有方 | 状态字段 | 生命周期 |
| --- | --- | --- | --- |
| Qi 卡 | adapter subscriber | `streamId` | `turn_start` -> `result` |
| Plan | adapter subscriber | `streamId` | first `TodoWrite` -> `result` |
| Text | adapter subscriber | debounced buffer | `text` events -> `turn_complete` / `result` |
| Status | adapter subscriber | `currentTool` / pending status | tool_use start -> tool result / abort |
| Scheduler fallback | scheduler | last delivered text / `turnDelivered` | `turn_complete` / `result` |

## cc_event x 出口动作表

| `cc_event` | Qi | Plan | Text | Status | Fallback |
| --- | --- | --- | --- | --- | --- |
| `tool_use(TodoWrite)` | noop | start/append | noop | noop | noop |
| `tool_use(其他)` | append(category) | noop | noop | set(toolName) | noop |
| `tool_result` | noop | noop | noop | clear | noop |
| `text` | noop | noop | append(debounce) | noop | noop |
| `result` | stopStream(settled chunks) | stopStream(last snapshot) | flush | clear | deliver if undeliveredText |
| `turn_abort` | abandon | abandon | flush/noop | clear | noop |

## 已知边界 / 反例

- `stopStream` 必须只使用 settled chunks，不能再 append final text；否则 Slack 会把 final 和 append 过的内容合并成重复输出。
- `task_update.details` 跨 `appendStream` 的 concat 行为来自当前 Slack Streaming API 实测，不应把它当作可无限扩展的稳定存储。
- Text subscriber 已经投递的文本必须进入 `EgressGate`，`turn_complete` / `result` fallback 只能投递剩余文本。
- Status bubble 必须在 `result` 和 synthetic `turn_abort` 都清空；worker crash 没有 `tool_result` 时只能依赖 abort 清理。
- Inject / respawn 后的新 turn 必须获得新 stream，不得复用上一个 turn 的 `streamId`。
- `channelSemantics: silent` 应直接抑制 subscriber 输出，避免 cron 成功路径污染 Slack。
