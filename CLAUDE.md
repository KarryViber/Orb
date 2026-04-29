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
  spawn.js             — Claude CLI subprocess spawn helper
  mcp-permission-server.js — In-process MCP server backing CLI permission prompts
  skill-review-trigger.js — Skill-review mode dispatch hook
  lesson-candidates.js — Lesson candidate detection / persistence
  turn-delivery/       — Per-turn delivery orchestrator (intents/ledger/adapter-strategy/orchestrator)
  adapters/
    interface.js       — PlatformAdapter abstract base class
    slack.js           — Slack Socket Mode implementation
    slack-format.js    — Markdown→mrkdwn, Block Kit builder
    wechat.js          — WeChat adapter
    wechat-format.js   — WeChat plain-text formatter (Markdown unsupported)
    image-cache.js     — Adapter-shared image download/cache helper
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

Cron workers are dispatched with IPC `channelSemantics: "silent"`, so successful worker text is suppressed by scheduler contract after any target-channel delivery. Worker `error` messages and non-success `result.stopReason` remain deliverable as failure receipts.

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
| Scheduler → Worker | `task` | `{ type: 'task', userText, fileContent, imagePaths, threadTs, channel, userId, platform, threadHistory, profile, model, effort, channelSemantics?, maxTurns?, mode?, priorConversation?, disablePermissionPrompt?, attemptId? }` | Initial task for a thread. `attemptId` is generated by the scheduler if absent and threads through every downstream IPC payload for delivery-ledger correlation. `channelSemantics` is `'reply'` (default), `'silent'` (suppress successful worker text delivery), or reserved `'broadcast'`. `maxTurns` overrides Claude CLI `--max-turns` for that task only. `mode: 'skill-review'` requires `priorConversation`, which `context.js` injects as review context. `disablePermissionPrompt` skips the in-process MCP permission prompt server for that task. |
| Scheduler → Worker | `inject` | `{ type: 'inject', injectId?, attemptId?, userText, fileContent?, imagePaths? }` | Injects a follow-up user message into the active same-thread Claude CLI session without spawning a new worker. `injectId` lets the scheduler correlate acceptance/failure for fail-forward replay. When `imagePaths` is present the worker attaches them as image content blocks before sending the turn. |
| Worker → Scheduler | `turn_start` | `{ type: 'turn_start', injectId?, attemptId? }` | Emitted immediately when the worker receives a `task` or accepted `inject`, making the scheduler the typing owner. On accepted injects the worker echoes `injectId` so the scheduler can clear the pending replay token. |
| Worker → Scheduler | `turn_end` | `{ type: 'turn_end' }` | Emitted when Claude CLI produces a `result` event for the current turn; scheduler stops typing immediately. |
| Worker → Scheduler | `turn_complete` | `{ type: 'turn_complete', text, toolCount, lastTool, stopReason, channelSemantics, deliveredTexts, undeliveredText?, gitDiffSummary? }` | Signals that one Claude turn finished; scheduler can deliver final text while keeping the worker alive for future `inject` messages. Scheduler drops successful text when `channelSemantics === 'silent'` and records a receipt. `gitDiffSummary` is included when the worker detected source-tree changes during the turn. |
| Worker → Scheduler | `cc_event` | `{ type: 'cc_event', turnId, attemptId?, eventType, payload }` | Raw Claude Code event forwarded to scheduler subscribers. Slack Qi, plan, text, and status rendering is driven from this stream. |
| Worker → Scheduler | `inject_failed` | `{ type: 'inject_failed', injectId?, attemptId?, userText, fileContent?, imagePaths? }` | Follow-up inject could not reach the live CLI session (for example the session already closed). Scheduler must fail forward by replaying that payload through a fresh worker on the same thread. |
| Worker → Scheduler | `error` | `{ type: 'error', error, errorContext? }` | Terminal failure payload. |
| Worker → Scheduler | `result` | `{ type: 'result', text, stopReason?, channelSemantics, exitOnly: true, toolCount?, lastTool? }` | Worker process-exit completion signal. `text` is usually empty — final-text delivery already happened via `turn_complete`, and the worker suppresses duplicates by comparing against the last emitted turn text. `result` is kept for lifecycle / auto-continue / non-success `stopReason` surfacing. |

Adding or changing message types/payload fields requires updating `worker.js` header comment, `scheduler.js` handler, and this section together.

### Task Card Routing

Worker no longer emits Slack UI primitives. It forwards Claude Code events as `cc_event`; scheduler publishes them to subscribers registered by the Slack adapter.

**Qi card path**:
- Slack subscriber listens to `cc_event tool_use/result`.
- Non-TodoWrite tools are bucketed into `Probe` / `Delegate` / `Distill` by `categorizeTool`.
- Subscriber owns stream start, append ordering, and result-time finalization.

**TodoWrite path**:
- Slack subscriber listens to `cc_event tool_use` where `name === 'TodoWrite'`.
- It rebuilds the full plan rows from `input.todos` and updates its own plan stream.

**status bubble**（stream 侧边细字）：
- Slack status subscriber derives active tool status from `cc_event tool_use` and clears on `cc_event result`.

**无工具 turn**：
- Text subscriber debounces `cc_event text`; final delivery still goes through `turn_complete` / `result`.

### Task Card Lifecycle

**Qi stream**:
- Slack adapter subscriber owns per-turn Qi stream state.
- It starts a `task_display_mode: 'plan'` stream with `Orbiting...` plus `Probe` / `Delegate` / `Distill` placeholders.
- Per-tool appends use `task_update.details` deltas, relying on Slack's cross-append concat behavior for repeated `task_update.id`.
- On `cc_event result`, it stops the stream with settled chunks only; do not append the same final chunks first.

**TodoWrite plan stream**:
- Slack adapter subscriber owns per-turn plan stream state.
- First TodoWrite starts a plan stream; later TodoWrite events append the rebuilt row snapshot.
- On `cc_event result`, it stops the stream with the last known plan chunks.

**共同约束**：
- Slack stream per-turn per-message；`inject` 跨 turn 不复用 stream。
- Slack 返回 `message_not_in_streaming_state` / `message_not_owned_by_app` 时降级为普通消息。
- 跨 appendStream 对 `task_update.details` 的 concat 行为是 Slack 官方未明文说明但经实测稳定的路径——改动相关逻辑前先查 `profiles/karry/data/lessons/slack-stream-chunk-semantics.md`。

### Immutable Constraints

- **Claude Code CLI is the only agent runtime** — no other LLM SDKs
- **Workers are short-lived per-thread processes** — fork on first message, accept same-thread `inject` follow-ups, exit on idle timeout, never reused across threads
- **Orb runtime must not modify its own source code** — use spec files for external sessions to execute
- **config.json is the sole routing configuration source** — no hardcoded userId/profile mappings in code
