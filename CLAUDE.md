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
- Memory layers policy: `docs/memory-policy.md`

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

`defaults.model` / `defaults.effort` — Slack 人工触发 worker 的默认模型/推理深度。优先级：消息前缀 `[model]`/`[effort:X]` > 关键词自动升级 > `defaults.*` > 内置兜底（effort=low，model 不传）。SIGHUP 不刷新（仅重启 daemon 生效）。

long-running turn（skill 写入、批量 refactor 等）超过默认 30 分钟可上调 `ORB_WORKER_TIMEOUT_MS` 重启 daemon 生效。

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
- `"maxTurns"`: positive integer override for Claude CLI `--max-turns`, e.g. `"maxTurns": 60`

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
| Scheduler → Worker | `task` | `{ type: 'task', userText, fileContent, imagePaths, threadTs, channel, userId, platform, threadHistory, profile, model, effort, maxTurns?, mode?, priorConversation? }` | Initial task for a thread. `maxTurns` overrides Claude CLI `--max-turns` for that task only. `mode: 'skill-review'` requires `priorConversation`, which `context.js` injects as review context. |
| Scheduler → Worker | `inject` | `{ type: 'inject', injectId?, userText, fileContent?, imagePaths? }` | Injects a follow-up user message into the active same-thread Claude CLI session without spawning a new worker. `injectId` lets the scheduler correlate acceptance/failure for fail-forward replay. When `imagePaths` is present the worker attaches them as image content blocks before sending the turn. |
| Worker → Scheduler | `result` | `{ type: 'result', text, toolCount, lastTool?, stopReason? }` | Final payload emitted when the worker is about to exit. |
| Worker → Scheduler | `error` | `{ type: 'error', error, errorContext? }` | Terminal failure payload. |
| Worker → Scheduler | `turn_start` | `{ type: 'turn_start', injectId? }` | Phase ②: emitted immediately when the worker receives a `task` or accepted `inject`, making the scheduler the sole typing owner. On accepted injects the worker echoes `injectId` so the scheduler can clear the pending replay token. |
| Worker → Scheduler | `turn_end` | `{ type: 'turn_end' }` | Phase ②: emitted when Claude CLI produces a `result` event for the current turn; scheduler stops typing immediately. |
| Worker → Scheduler | `turn_complete` | `{ type: 'turn_complete', text, toolCount, lastTool, stopReason, deliveredTexts, undeliveredText? }` | Signals that one Claude turn finished; scheduler can deliver it while keeping the worker alive for future `inject` messages. When `intermediate_text` already emitted partial content, `undeliveredText` contains only the remaining text that still needs delivery. |
| Worker → Scheduler | `progress_update` | `{ type: 'progress_update', text }` | Phase ①: emitted on every TodoWrite event. Scheduler posts on first occurrence (stores `ts`), then edits in-place on subsequent ones. In Wave 2 this is only used outside the task-card path and for non-stream/error fallback scenarios. |
| Worker → Scheduler | `plan_title_update` | `{ type: 'plan_title_update', title }` | Task-card compatibility path: callers can still set a plan-mode card title without changing task rows. |
| Worker → Scheduler | `plan_snapshot` | `{ type: 'plan_snapshot', title, chunk_type, display_mode, rows }` | TodoWrite task-card path: worker sends the full TodoWrite row set in one IPC so scheduler can rebuild a single Slack plan card. `rows` is an ordered array of `{ task_id, title, status }` and replaces the current TodoWrite plan snapshot for that turn. |
| Worker → Scheduler | `tool_call` | `{ type: 'tool_call', task_id, tool_name, title, details, status?, chunk_type, display_mode? }` | Task-card path: emitted for selected `tool_use` blocks so the scheduler can render/update Slack task cards. `task_id` is normally the Claude `tool_use` block id. The first task-card event in a turn fixes `chunk_type: 'task' | 'plan'` for the whole turn and may carry an explicit `display_mode`. |
| Worker → Scheduler | `tool_result` | `{ type: 'tool_result', task_id, status, output }` | Task-card path: emitted from `tool_result` blocks for tools that wait on a result. `status` is `complete` or `error`, and `output` is a truncated human-readable summary. |
| Worker → Scheduler | `status_update` | `{ type: 'status_update', text }` | Short assistant thread status text. Emitted when a tool starts outside the task-card path so scheduler can call Slack assistant thread status APIs, and cleared with empty text at turn completion. |
| Worker → Scheduler | `inject_failed` | `{ type: 'inject_failed', injectId?, userText, fileContent?, imagePaths? }` | Follow-up inject could not reach the live CLI session (for example the session already closed). Scheduler must fail forward by replaying that payload through a fresh worker on the same thread. |
| Worker → Scheduler | `intermediate_text` | `{ type: 'intermediate_text', text }` | Phase ③: mid-turn assistant text block, debounced 2s. Scheduler delivers immediately; `turn_complete` deduplicates against `deliveredTexts` to avoid re-sending. |

Adding or changing message types/payload fields requires updating `worker.js` header comment, `scheduler.js` handler, and this section together.

### Task Card Routing

Non-TodoWrite 工具走 **Qi 实时卡**（独立 stream），TodoWrite 走既有 `plan_snapshot` 卡（独立第二条 stream）。两条路径并行不互相干扰。

**Qi 卡路径**（非 TodoWrite）：
- Worker 见首个 task-card-qualifying tool_use 时发 `qi_start` IPC。
- 每个 tool_use 发 `qi_append { category, line }`——category 由 `categorizeTool` 映射（Bash/Read/Edit/Write/Grep/Glob/NotebookEdit/WebFetch/WebSearch → `Probe`；Task/Agent/Skill/mcp__* → `Delegate`；summary 用 `Distill`）。
- Worker 的 `result` 处理分支遇 `qiStreamOpened` 时发 `qi_finalize`——**该触发独立于 `turnOpen`**，以覆盖 Claude CLI 的 auto-continue 场景。

**TodoWrite 路径**：
- 保持 `plan_snapshot` 单一 IPC，包含完整 `rows`。
- Scheduler 走 task-card stream（区别于 Qi stream），display_mode 始终 'plan'。

**status bubble**（stream 侧边细字）：
- 与任一 stream 并行，90s refresh，避开 Slack 2 分钟自清。

**无工具 turn**：
- 走 `progress_update` / `intermediate_text` / 最终 reply 路径，不开 Qi stream。

### Task Card Lifecycle

**Qi stream**：
- Scheduler 用独立 `turn.qiStreamId` 管理，开/关操作走独立 `chainQiAppend` 串行链，与 TodoWrite task-card stream (`turn.taskCardState.streamId`) 不冲突。
- `qi_start` → 用 `task_display_mode: 'plan'` 开 stream，initial_chunks = `plan_update { title: 'Orbiting...' }` + 3 条空 task_update 占位（id: `qi-exec` / `qi-other` / `qi-summary`，title: `Probe` / `Delegate` / `Distill`）。
- `qi_append` → appendStream 一条 task_update，details = `\n<line>\n`。**利用 Slack 跨 appendStream 对同 id `task_update.details` 字段 concat 而非 replace 的特性累积 bullet**。依赖 `src/adapters/slack.js` 的 `preserveStreamTaskField`（只对 `details` 保留首尾空白，不 trim）。
- `qi_finalize` → 补 `plan_update { title: 'Settled' }` + 3 条 task_update complete（summary 的 details 为 `Distilled from N probes`），stopStream。

**TodoWrite task-card stream**（不变）：
- 首个 task-card IPC 时 lazy 开 stream，用 in-flight promise 防重复。
- 每次 TodoWrite `plan_snapshot` 重建完整 rows 并 append（scheduler 内部 reconcile by id）。
- stopStream 前 in_progress 残留 task 统一转 error。

**共同约束**：
- Slack stream per-turn per-message；`inject` 跨 turn 不复用 stream。
- Slack 返回 `message_not_in_streaming_state` / `message_not_owned_by_app` 时降级为普通消息。
- 跨 appendStream 对 `task_update.details` 的 concat 行为是 Slack 官方未明文说明但经实测稳定的路径——改动相关逻辑前先查 `profiles/karry/data/lessons/slack-stream-chunk-semantics.md`。

### Immutable Constraints

- **Claude Code CLI is the only agent runtime** — no other LLM SDKs
- **Workers are short-lived per-thread processes** — fork on first message, accept same-thread `inject` follow-ups, exit on idle timeout, never reused across threads
- **Orb runtime must not modify its own source code** — use spec files for external sessions to execute
- **config.json is the sole routing configuration source** — no hardcoded userId/profile mappings in code
