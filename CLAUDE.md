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

`defaults.model` / `defaults.effort` — Slack 人工触发 worker 的默认模型/推理深度。优先级：消息前缀 `[model]`/`[effort:X]` > 关键词自动升级 > `defaults.*` > 内置兜底（effort=low，model 不传）。SIGHUP 不刷新（仅重启 daemon 生效）。

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

### Immutable Constraints

- **Claude Code CLI is the only agent runtime** — no other LLM SDKs
- **Workers are short-lived per-thread processes** — fork on first message, accept same-thread `inject` follow-ups, exit on idle timeout, never reused across threads
- **Orb runtime must not modify its own source code** — use spec files for external sessions to execute
- **config.json is the sole routing configuration source** — no hardcoded userId/profile mappings in code
