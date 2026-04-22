# Typing State — 显式 turn-state 替换 stdout-silence 启发

**目标**：修复两个方向的 typing bug —— (a) Opus 长 tool call 沉默时 typing 消失；(b) worker idle 等 inject 时 typing 矫枉过正。

---

## 当前病灶

两个典型源头并存，靠 `markActivity`（监听 stdout 行）推断 busy/idle —— 信号错位。

| 源 | 位置 | 问题 |
|---|---|---|
| Scheduler 5s 自循环 | `src/scheduler.js:184` startTyping | 与 worker heartbeat 冗余 |
| Worker 8s heartbeat | `src/worker.js:84` setInterval | 依赖错误的 busy/idle 信号 |
| `markActivity` 启发 | `src/worker.js:324` | stdout 静默 ≠ Claude 闲置 |

---

## 改造

### 1. Worker 侧：显式 turn 信号

用 **turn_start / turn_end** 替代 `markActivity`/`busy`/`idle`：

- 收到 `task` IPC → 立即 `ipcSend({type:'turn_start'})`
- 收到 inject → 同样 `turn_start`
- CLI 吐出 `result` 事件 → `ipcSend({type:'turn_end'})`

删除：
- `src/worker.js` 的 heartbeat `setInterval` (line ~84)
- `markActivity()` 的 onActivity('idle'/'busy') 调用（保留 idle timer for CLI stdin close，只是不再外发 IPC）
- worker → scheduler 的 `typing_heartbeat`、`idle`、`busy` IPC（整块删）

### 2. Scheduler 侧：单一 typing owner

`src/scheduler.js`：
- 保留 `startTyping` / `stopTyping` 和 5s interval
- 任务提交时**不再自动** `startTyping` —— 改由 worker `turn_start` 触发
- 新增 IPC handler: `turn_start` → `startTyping()`；`turn_end` → `stopTyping()`
- 删除 `typing_heartbeat`、`idle`、`busy` 旧 handler
- `result` / `error` / `onExit` 仍兜底调 stopTyping

### 3. IPC Protocol 文档更新

`~/Orb/CLAUDE.md` § Worker IPC Protocol：
- 删除 `typing_heartbeat`、`idle`、`busy` 三行
- 新增 `turn_start`、`turn_end` 两行，payload `{}`
- Header 注释同步更新

---

## 验收

1. `node --check src/worker.js && node --check src/scheduler.js` 通过
2. Daemon 重启后跑一个长任务（10+ tool calls，比如 PPT 改造）：
   - Slack typing 全程持续不断，包括 tool call 间隙
3. 任务完成后（无 inject）：
   - Slack typing 立即停掉
   - worker idle 60s 等 inject 期间**不再** typing
4. Phase ①（progress_update）、Phase ③（intermediate_text）功能保持不变 —— 只是 typing 改了

---

## 非目标

- 不动 progress_update / intermediate_text 逻辑
- 不动 CLI stream 解析
- 不动 idle timeout（60s）关 stdin 的行为 —— 那是 CLI 生命周期管理，跟 typing 无关

---

## Commit

单个 commit：`refactor(worker,scheduler): explicit turn-state for typing ownership, retire stdout-silence heuristic`
