# Orb — Multi-profile AI Agent Framework

Receive messages via Slack (Discord/WeChat planned), fork Claude Code CLI to execute tasks.

## Architecture

```
src/
  main.js              — Entry point, adapter init, signal handling
  scheduler.js         — Worker lifecycle, task queue, scheduling
  config.js            — config.json loading, profile routing
  worker.js            — Fork child process, invoke Claude CLI
  cron.js              — Cron scheduled tasks (60s tick, job persistence, schedule parsing)
  context.js           — Prompt assembly (CLI-native layers + Orb recall/docs/thread injection)
  session.js           — thread↔session persistence (per-profile isolation)
  memory.js            — Holographic memory retrieval + conversation storage (via Python bridge)
  format-utils.js      — Platform-agnostic text utilities (sanitize, split)
  log.js               — Console + file dual-write, 50MB auto-rotation
  queue.js             — Global task FIFO queue
  adapters/
    interface.js       — PlatformAdapter abstract base class
    slack.js           — Slack Socket Mode implementation
    slack-format.js    — Markdown→mrkdwn, Block Kit builder
```

## Key Paths

- `profiles/{name}/scripts/`              — User utility scripts
- `profiles/{name}/workspace/`            — Claude CLI working directory (cwd per profile)
- `profiles/{name}/workspace/CLAUDE.md`   — Agent persona + runtime constraints (CLI auto-discovers from cwd)
- `profiles/{name}/workspace/.claude/skills/*/SKILL.md` — Per-profile skills (CLI auto-discovers via cwd)
- `profiles/{name}/data/`                 — sessions.json + memory.db + doc-index.db + cron-jobs.json (gitignored)
- `lib/holographic/`                      — Holographic memory engine (Python)
- `lib/docstore/`                         — DocStore file index (FTS5, Python)
- `config.json`                           — Profile routing + adapter configuration

## Prompt Architecture

Worker invokes Claude CLI with `--append-system-prompt`, letting CLI
natively inject (via auto-discovery):
- CLAUDE.md (three layers: `~/.claude`, `~/Orb/`, `{cwd}/` = workspace/)
- Skills from `{cwd}/.claude/skills/*/SKILL.md` (per-profile via cwd)
- Agents from `~/.claude/agents/` + `{cwd}/.claude/agents/`
- Auto-memory from `~/.claude/projects/{encoded-cwd}/memory/MEMORY.md`

Orb's system-prompt contribution (appended, minimal):
- Scripts path pointer (`profile.scriptsDir`)

Orb's user-prompt layers (dynamic per-turn, injected via stream-json stdin):
- Holographic memory recall (cross-thread, trust-weighted)
- DocStore recall (project-slug scoped)
- Thread history (from platform adapter)
- Skill-review prior conversation (conditional, `mode === 'skill-review'`)
- Thread metadata + file attachments + user message

## Config

`config.json` supports `${ENV_VAR}` interpolation. `SIGHUP` is a partial reload only: it re-runs `loadConfig(true)` and refreshes the cron scheduler's profile-name set. It does not rebuild adapters, rotate adapter tokens, reconnect Socket Mode, restart active workers, or apply scheduler parameter changes already loaded in memory. Restart the daemon for full effect.

## Dev

```bash
npm run dev          # --watch mode
npm start            # Production start (managed by launchd)
```

## Conventions

- ESM (type: module), Node >= 18, pure JS
- Workers are short-lived per-thread processes — forked on first message, reused for follow-up messages in the same thread via `inject` IPC, exit on idle timeout, never reused across threads
- Do not modify core files of a running Orb instance (main/scheduler/worker/adapters) — use spec files for external sessions to execute

## Cron

Jobs stored in `profiles/{name}/data/cron-jobs.json`. CronScheduler ticks every 60s, checks due jobs and forks workers to execute.

Job format:
```json
{
  "id": "abc123",
  "name": "Daily Report",
  "prompt": "Generate daily report...",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *" },
  "deliver": { "platform": "slack", "channel": "C01234", "threadTs": null },
  "profileName": "default",
  "enabled": true,
  "repeat": { "times": null, "completed": 0 },
  "model": "haiku",
  "effort": "low",
  "nextRunAt": "2026-04-15T09:00:00+09:00",
  "lastRunAt": null, "lastStatus": null, "lastError": null
}
```

Optional fields:
- `"model"`: `"haiku"` | `"sonnet"` | `"opus"` (default: system default, usually opus)
- `"effort"`: `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"` (Opus defaults xhigh)

Token tier guidelines:
| Task type | model | effort |
|-----------|-------|--------|
| Script-driven / templated output | `haiku` | `low` |
| Summary / aggregation | `sonnet` | `medium` |
| Knowledge distillation / decision review | `sonnet` | `high` |
| Deep analysis / client-facing (rarely cron) | `opus` | `xhigh` |

Schedule types: `"0 9 * * *"` (cron), `"every 30m"` (interval), `"2h"` / ISO (one-shot).
Agents manage tasks by directly reading/writing cron-jobs.json (Claude CLI native file operations).

---

## Architecture Constraints

The following rules are invariants established during architecture evolution. Any session modifying source code must comply.

### File Responsibility Layers

| File | Reader | Responsibility | Maintenance frequency |
|------|--------|----------------|----------------------|
| `~/Orb/CLAUDE.md` (this file) | External Claude Code sessions (when modifying source) | Developer guide + architecture constraints | On architecture changes |
| `profiles/{name}/workspace/CLAUDE.md` | Claude CLI (auto-discovered from cwd) | Agent persona + runtime constraints + execution discipline | Regular maintenance |
| `profiles/{name}/soul/*.md` | — (retired) | Retired — persona merged into `workspace/CLAUDE.md` | — |
| `profiles/{name}/data/MEMORY.md` | — (retired) | Retired — CLI auto-memory (`~/.claude/projects/.../memory/MEMORY.md`) replaces it | — |

Single-layer (workspace/CLAUDE.md) + CLI auto-memory: persona, decision principles, and runtime constraints all live in `workspace/CLAUDE.md`; persistent user preferences are captured by Claude CLI's native auto-memory keyed on cwd.

### Profile Isolation

- Each profile uses independent `scripts/`, `workspace/` (with `workspace/.claude/skills/` for per-cwd skill isolation), and `data/` paths under `profiles/{name}/`
- `userIds` mapping in `config.json` determines which profile a user belongs to; unmapped `userId`s are rejected (no `default` fallback)
- Session data is isolated by `{platform}:{threadTs}` key, stored in each profile's `data/sessions.json`
- Runtime root/path validation hard-checks `workspace/` and `data/`; `scripts/` is resolved per-profile but not enforced by the same guard
- Adding a user = create profile directory + add mapping in config.json, no source code changes

### Platform Abstraction

- `adapters/interface.js` defines the `PlatformAdapter` abstract base class
- One adapter per platform (slack.js), implementing `start/disconnect/sendReply/editMessage/uploadFile/setTyping/sendApproval/buildPayloads/fetchThreadHistory`
- Platform-specific formatting in `adapters/{platform}-format.js`, shared utilities in `format-utils.js`
- `scheduler.js` operates platforms only through the adapter interface, never importing platform SDKs directly
- Adding a platform = new adapter + format file + config.json entry, no changes to scheduler/worker/context

### Worker IPC Protocol

Scheduler ↔ Worker communication via Node IPC (process.send/on('message')):

| Direction | Type | Payload | Notes |
|-----------|------|---------|-------|
| Scheduler → Worker | `task` | `{ type: 'task', userText, fileContent, imagePaths, threadTs, channel, userId, platform, threadHistory, profile, model, effort, mode?, priorConversation? }` | Initial task for a thread. `mode: 'skill-review'` requires `priorConversation`, which `context.js` injects as review context. |
| Scheduler → Worker | `inject` | `{ type: 'inject', userText, fileContent?, imagePaths? }` | Injects a follow-up user message into the active same-thread Claude CLI session without spawning a new worker. When `imagePaths` is present the worker attaches them as image content blocks before sending the turn. |
| Worker → Scheduler | `result` | `{ type: 'result', text, toolCount, lastTool?, stopReason? }` | Final payload emitted when the worker is about to exit. |
| Worker → Scheduler | `error` | `{ type: 'error', error, errorContext? }` | Terminal failure payload. |
| Worker → Scheduler | `turn_start` | `{ type: 'turn_start' }` | Phase ②: emitted immediately when the worker receives a `task` or accepted `inject`, making the scheduler the sole typing owner. |
| Worker → Scheduler | `turn_end` | `{ type: 'turn_end' }` | Phase ②: emitted when Claude CLI produces a `result` event for the current turn; scheduler stops typing immediately. |
| Worker → Scheduler | `turn_complete` | `{ type: 'turn_complete', text, toolCount, lastTool, stopReason, deliveredTexts, undeliveredText? }` | Signals that one Claude turn finished; scheduler can deliver it while keeping the worker alive for future `inject` messages. When `intermediate_text` already emitted partial content, `undeliveredText` contains only the remaining text that still needs delivery. |
| Worker → Scheduler | `progress_update` | `{ type: 'progress_update', text }` | Phase ①: emitted on every TodoWrite event. Scheduler posts on first occurrence (stores `ts`), then edits in-place on subsequent ones. In Wave 2 this is only used outside the task-card path and for non-stream/error fallback scenarios. |
| Worker → Scheduler | `tool_call` | `{ type: 'tool_call', task_id, tool_name, title, details, chunk_type, display_mode? }` | Task-card path: emitted for selected `tool_use` blocks so the scheduler can render/update Slack task cards. `task_id` is the Claude tool_use block id. The first task-card event in a turn fixes `chunk_type: 'task' | 'plan'` for the whole turn and may carry `display_mode: 'timeline'`. |
| Worker → Scheduler | `tool_result` | `{ type: 'tool_result', task_id, status, output }` | Task-card path: emitted from `tool_result` blocks. `status` is `complete` or `error`, and `output` is a truncated human-readable summary. |
| Worker → Scheduler | `status_update` | `{ type: 'status_update', text }` | Short assistant thread status text. Emitted when a tool starts outside the task-card path so scheduler can call Slack assistant thread status APIs, and cleared with empty text at turn completion. |
| Worker → Scheduler | `intermediate_text` | `{ type: 'intermediate_text', text }` | Phase ③: mid-turn assistant text block, debounced 2s. Scheduler delivers immediately; `turn_complete` deduplicates against `deliveredTexts` to avoid re-sending. |

Adding or changing message types/payload fields requires updating `worker.js` header comment, `scheduler.js` handler, and this section together.

### Task Card Routing

- Task-card path is enabled only when a turn emits whitelisted `tool_use` blocks and the worker sends `tool_call` / `tool_result` IPC messages.
- `chunk_type` is still decided by the worker on the first task-card tool in a turn (`TodoWrite` uses `'task'`, other tools use `'plan'`), but since v3.3 `display_mode` is always `'timeline'`; `chunk_type` remains semantic only and does not change Slack rendering.
- `progress_update` remains the non-stream fallback/status surface for TodoWrite outside the task-card path and in failure/fallback scenarios.
- `status_update` and task-card streaming are mutually exclusive within a turn: once the worker emits any `tool_call`, scheduler ignores later `status_update` events for that turn.
- Pure text turns or turns without task-card-qualified tools continue through the normal `progress_update` / `intermediate_text` / final reply path.

### Task Card Lifecycle

- Slack task-card streams are per-turn, per-message. Orb must not reuse a prior stream across `inject` follow-up turns.
- Scheduler opens a stream lazily on the first `tool_call`, using timeline rendering for the turn.
- Timeline rendering is used for both TodoWrite and non-TodoWrite tool chains; each tool remains a `task_update` item and can carry `details` / `output`.
- Before `stopStream`, any task card still left `in_progress` is converted to `error` with a timeout fallback output so cards do not remain running forever.
- `stopStream` carries the final task-update chunks plus optional `markdown_text` and rich `blocks`; extra overflow payloads are sent as normal follow-up replies if needed.
- If Slack returns ownership/stream-state errors such as `message_not_in_streaming_state` or `message_not_owned_by_app`, Orb degrades to normal message delivery for that turn instead of reusing the broken stream.

## Delivery / Stream / Status / IPC 架构图谱

今天（2026-04-22）集中修了 8 个 bug，全部落在 delivery / stream / status / IPC 的交界处。下面把当前形状画清楚，下次开工前先过一遍。

### 1) Delivery 主线

Slack 出口共 5 个（按 adapter 方法数）：`sendReply` / `editMessage` / `startStream` / `appendStream` / `stopStream`（`stopStream` 的 `markdown_text` + `blocks` 字段是隐式文本出口）。scheduler 一个 turn 内「最终文本兑付」可能途径：

```
                          ┌── intermediate_text (sendReply, 设 intermediateDeliveredThisTurn=true)
 worker →                 │
 scheduler.run()  ────────┼── turn_complete ──┬── taskCardState.streamId? → stopTaskCardStream
  (closure)               │                   │      ├─ stopStream ok  → canvas 承载最终文本
                          │                   │      └─ catch (SSF-1) → editMessage 覆盖 canvas
                          │                   │                          └─ fail → sendReply
                          │                   ├── deferred?  → deliverDeferredFinalResult
                          │                   │                   (lazy startStream + stopStream,
                          │                   │                    catch → emitPayload 降级)
                          │                   ├── intermediateDeliveredThisTurn? → skip (SDP gate)
                          │                   └── else          → emitPayload (edit-or-send)
                          │
                          └── result (exit)  ── 同分支，外加 exit-path dedup：
                                                exitText === _lastEmittedTurnText → 清空 text
```

| 出口 | 触发点 | 幂等策略 |
|------|--------|---------|
| `sendReply` | intermediate_text / turn_complete 普通分支 / fallback | SDP flag + worker 端 `_lastEmittedTurnText` 游标 |
| `editMessage` | progress_update 二次起 / emitPayload 有 pendingEdit / SSFE 降级覆盖 canvas | `progressTs` per-turn reset |
| `startStream` | 首个 tool_call (ensureTaskCardStream) / deferred 投递时 lazy open | taskCardState.enabled + !failed |
| `appendStream` | tool_call / tool_result delta / keepalive touch | delta-only（不重发 details） |
| `stopStream` | turn_complete 有 streamId | SSF-1 catch 降级 |

### 2) Stream 生命周期

```
           ┌────────────────────────────────────────────────┐
           │            taskCardState (per worker run)      │
           │  enabled, deferred, failed, failureNotified    │
           │  streamId, streamTs, chunkType, displayMode    │
           │  taskCards Map<task_id, card>                  │
           │  bubbleCleared, missingThreadWarned            │
           └────────────────────────────────────────────────┘

 idle ──tool_call──▶ cards 累积
    │                    │
    │               (enabled?)
    │                    ▼
    │            ensureTaskCardStream ──startStream──▶ streaming
    │                                     │failed        │
    │                                     ▼              │ tool_call/tool_result
    │                            failTaskCardStream      │   └ appendStream (delta)
    │                            (edit canvas or         │     └ keepalive arm
    │                             sendReply fallback)    │
    │                                                    │
    │                           turn_complete ──────────▶│
    │                                                    ▼
    │                                         stopTaskCardStream
    │                                           ├ ok → done
    │                                           └ err → editMessage canvas / sendReply
    ▼
 resetTaskCardState（turn_start / 新 inject turn 清）
```

事件驱动：`tool_call` → `ensureTaskCardStream` → `armKeepalive`；`appendStream` 成功 → `armKeepalive`；`STREAM_KEEPALIVE_MS=20s` 内无活动 → touch (重发 taskUpdateChunks) → re-arm；失败 → `failTaskCardStream`。

### 3) Status（assistant.threads.setStatus）生命周期

```
 turn_start ──▶ startTyping(LOADING_MESSAGES[0]) ──▶ typingActive=true
                   └ applyThreadStatus(status) ──▶ setThreadStatus
                                                   └ pendingThreadStatus 非空 → armStatusRefresh

 armStatusRefresh: setTimeout(STATUS_REFRESH_MS=20s) → setThreadStatus 裸调 → re-arm
   （对抗 Slack server TTL ~30-60s 静默清空）

 ensureTaskCardStream ok ──▶ applyThreadStatus('') ──▶ clearStatusRefresh
   （stream keepalive 接管，两套互斥）

 failTaskCardStream ──▶ 若 typingActive 仍 true → 重新 applyThreadStatus(LOADING_MESSAGES[0])
   （Y#3：防止降级后 bubble 消失）

 turn_end ──▶ stopTyping ──▶ applyThreadStatus('') ──▶ clearStatusRefresh
```

| 变量 | 语义 | Reset 点 |
|------|------|---------|
| `typingActive` | scheduler 是否当前 turn typing owner | turn_start=true / turn_end=false |
| `pendingThreadStatus` | 当前期望状态文本（空=停） | applyThreadStatus 入口 |
| `pendingStatusLoadingMessages` | 跟随 pendingThreadStatus 的 loading 动画池 | 同上 |
| `statusRefreshTimer` | TTL 对抗定时器 | armStatusRefresh/clearStatusRefresh |
| `keepaliveTimer` | stream touch 定时器 | append 成功 / reset / fail |

### 4) IPC 协议（今日增补）

基础矩阵见 `### Worker IPC Protocol`。本轮新增 / 变更的语义：

- **`turn_complete.undeliveredText`**：worker 把已经走 `intermediate_text` 投递过的前缀裁掉，只留"还没发出去的那段"，scheduler 优先读 `undeliveredText`，fallback 回 `text`。
- **`_lastEmittedTurnText` 游标（worker 内）**：turn_complete 触发时赋值为 `undeliveredText || text`。`result`（CLI exit）分支对比 `exitResult.lastTurnText`，命中则把 `result.text` 清空，避免 60-75s 后 exit 重复投递。
- **reset 时机**：worker 收到 `task` 或接受 `inject` 时清 `_lastEmittedTurnText = null`。scheduler 侧 `turn_start` 清 `progressTs=null` + `intermediateDeliveredThisTurn=false`（P0-5 / SDP）。
- **SDP gate**：scheduler 端 `intermediateDeliveredThisTurn` 布尔 — intermediate 成功 sendReply 置 true，turn_complete / result 的普通分支据此跳过重复 sendReply。task card / deferred 分支不受 gate 影响。

### 5) 已知坑合集

| # | Commit | 根因 | 修复 | 防复发 |
|---|--------|------|------|--------|
| 1 | `af02e87` | CLI exit 60s+ 后 `result.text` 与 turn_complete 已发文本重复 | worker 端 `_lastEmittedTurnText` 游标，exit 路径对比清空 | 每次 task/inject 入口 reset 游标 |
| 2 | `3ca8970` | tool_result 重发 details，卡片重渲染 | tool_result 只发 delta (id/status/output) | delta-only 约定写进协议 |
| 3 | `e2315d5` | task card append 带全量 details，重复输出 | append 只发变更卡片 (`updateOnly=true`) | — |
| 4 | `79e77bf` | `markdownToMrkdwn` 把 `*中文*` 转成 `_中文_`（CJK 边界误判） | CJK 内容保留 `*X*` 语义，ZWSP 只加在星号外侧 | 测试用例固化（见 commit body） |
| 5 | `e8d4c1d` | push-notification fallback 泄漏 `**bold**` / ZWSP 原文 | `buildFallbackText` 剥离所有 emphasis / ZWSP | 180 字裁剪前统一过 helper |
| 6 | `7c31564` | Block Kit JSON 绕过 markdown→mrkdwn，`**bold**` 字面量 | `parseBlockKit` 递归跑转换 + fallback 过 `buildFallbackText` | — |
| 7 | `7ee290d` | `assistant.threads.*` API 静默 catch，thread_ts 失效时无日志 | 三处 catch 降级为 `warn` | 所有 catch 禁 silent |
| 8 | `9a0f3db` | stream 降级后 bubble 消失（applyThreadStatus('') 清掉） | failTaskCardStream 末尾检查 `typingActive`，重新 applyThreadStatus | typing owner 语义单点确定 |

**P2 未修（弱点登记）：**

- **Scheduler 端缺 egress fingerprint**：`sendReply` / `editMessage` / `stopStream(markdown_text)` 三路出口没有统一的「本 turn 已投递文本指纹集」，目前靠 `intermediateDeliveredThisTurn` 布尔 + worker 端 `_lastEmittedTurnText` 游标拼出去重。多一路出口（比如将来加 DM push）就要再加一个 flag。建议重构成 `Set<hash>`。
- **Per-turn flag 未收敛**：`progressTs` / `intermediateDeliveredThisTurn` / `pendingThreadStatus` / `typingActive` / `taskCardState.bubbleCleared` 散落在 `run()` 闭包里，turn 边界靠 `turn_start` handler 各自 reset。漏掉一个就是 P0-5 那种 bug。建议抽成 `TurnState` 对象 + `reset()` 方法。
- **Status refresh 与 keepalive 的互斥**靠调用顺序隐式保证（ensureTaskCardStream 里 applyThreadStatus('') clear timer）。没有断言，反向路径（stream 失败恢复 status）也是手写。值得加一个状态机不变式检查。

---

### Immutable Constraints

- **Claude Code CLI is the only agent runtime** — no other LLM SDKs
- **Workers are short-lived per-thread processes** — fork on first message, accept same-thread `inject` follow-ups, exit on idle timeout, never reused across threads
- **Orb runtime must not modify its own source code** — use spec files for external sessions to execute
- **config.json is the sole routing configuration source** — no hardcoded userId/profile mappings in code
