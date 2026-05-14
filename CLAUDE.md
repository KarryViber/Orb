# Orb — Multi-profile AI Agent Framework

Receive messages via Slack (Discord planned), fork Claude Code CLI to execute tasks.

## Architecture

```
src/
  main.js              — Entry point, adapter init, signal handling
  scheduler.js         — Worker lifecycle, task queue, scheduling (entry; submodules under scheduler/)
  config.js            — config.json loading, profile routing
  worker.js            — Fork child process, invoke Claude CLI (entry; submodules under worker/)
  cron.js              — Cron scheduled tasks (60s tick, job persistence, schedule parsing; submodules under cron/)
  cron-delivery.js     — Cron output delivery dispatcher (deliver.mode routing)
  context.js           — Prompt assembly (CLI-native layers + Orb recall/docs/thread injection)
  dm-routing-schema.js — DM inbound routing schema validation
  docstore.js          — DocStore Node-side wrapper / Python bridge calls
  session.js           — thread↔session persistence (per-profile isolation)
  memory.js            — Holographic memory retrieval + conversation storage (via Python bridge)
  format-utils.js      — Platform-agnostic text utilities (sanitize, split)
  ipc-schema.js        — Worker IPC message schema definitions and validation
  log.js               — Console + file dual-write, 50MB auto-rotation
  queue.js             — Global task FIFO queue
  runtime-env.js       — Runtime environment loading and validation
  scheduler-memory-maintenance.js — Scheduler-side memory maintenance tasks
  scheduler-shutdown-persistence.js — Scheduler shutdown state persistence
  scheduler-skill-review.js — skill-review mode scheduler dispatch
  spawn.js             — Claude CLI subprocess spawn helper
  stop-reason.js       — CLI stop reason classification helpers
  mcp-permission-server.js — In-process MCP server backing CLI permission prompts
  skill-review-trigger.js — Skill-review mode dispatch hook
  lesson-candidates.js — Lesson candidate detection / persistence
  worker-git-diff.js   — Worker-side git diff summary collection
  worker-image-blocks.js — Worker-side image attachment → content block conversion
  worker-mcp-boot.js   — Worker-side MCP server startup
  worker-turn-text.js  — Worker-side turn text buffering and deduplication
  scheduler/           — Scheduler submodules (extracted from scheduler.js)
    task-normalizer.js — Inbound task payload normalization
    turn-lifecycle.js  — Turn start/complete/result lifecycle bookkeeping
    worker-runner.js   — Worker fork + IPC plumbing
  worker/              — Worker submodules (extracted from worker.js)
    cc-stream-parser.js — Claude CLI stream-json event parser
    tool-event-state.js — Per-turn tool event state machine
  cron/                — Cron submodules (extracted from cron.js)
    heartbeat-receipt.js — Cron heartbeat / receipt emission
    job-completion.js  — Cron job completion bookkeeping
    run-cron-job.js    — Per-job execution helper
  context-providers/   — User-prompt external context providers
    interface.js       — Provider interface (name + prefetch)
    holographic.js     — Holographic memory recall provider
    docstore.js        — DocStore recall provider
    scratchpad.js      — Cross-turn scratchpad projection provider
    thread-history.js  — Thread history provider
    skill-review.js    — Skill-review prior-conversation provider
    cron-protocol.js   — Cron delivery protocol injection provider
    cron-history.js    — Cron task history provider
    channel-meta.js    — Slack channel topic/purpose provider
    legacy-attachment.js — Legacy file/image attachment provider
  turn-delivery/       — Per-turn delivery orchestration
    orchestrator.js    — Turn delivery orchestration (single egress owner)
    intents.js         — Delivery intent classification
    adapter-strategy.js — Adapter delivery strategy selection
    ledger.js          — Delivery ledger and attempt correlation
    status.js          — Turn status derivation
    cc-event-format.js — Claude Code event formatting helpers
    cc-event-subscriber.js — Claude Code event subscriber registry
    task-card-format.js — Task card payload formatting helpers
    task-card-streams.js — Task card stream lifecycle helpers
    text-stream.js     — Assistant text stream delivery
  adapters/
    slack.js           — Slack Socket Mode implementation (entry; submodules under slack/)
    slack-format.js    — Markdown→mrkdwn, Block Kit builder
    slack-block-actions.js — Slack block action (button click) routing
    slack-block-action-card.js — Slack block action card rendering
    slack-block-action-script.js — Slack block action handler-script dispatch
    slack-dm-routing.js — Slack DM inbound routing implementation
    slack-permission-render.js — Slack permission prompt rendering
    slack-stream-error.js — Slack stream error classification & fallback
    slack/             — Slack adapter submodules
      thread-context.js — Thread metadata / history context helpers
      stream-client.js — Slack streaming API client
      message-router.js — Inbound message routing helpers
      approval-controller.js — Approval-card lifecycle controller
    image-cache.js     — Adapter-shared image download/cache helper
```

## Key Paths

- `profiles/{name}/scripts/`              — User utility scripts
- `profiles/{name}/workspace/`            — Claude CLI working directory (cwd per profile)
- `profiles/{name}/workspace/CLAUDE.md`   — Agent persona + runtime constraints (CLI auto-discovers from cwd)
- `profiles/{name}/workspace/.claude/skills/*/SKILL.md` — Per-profile skills (CLI auto-discovers via cwd)
- `profiles/.claude/skills/*/SKILL.md` — System-scope skills shared across profiles (loaded via worker `--add-dir profiles/`)
- `profiles/{name}/data/`                 — sessions.json + memory.db + doc-index.db + cron-jobs.json (gitignored)
- `lib/holographic/`                      — Holographic memory engine (Python)
- `lib/docstore/`                         — DocStore file index (FTS5, Python)
- `config.json`                           — Profile routing + adapter configuration
- Memory layers policy: `docs/memory-policy.md`

## Prompt Architecture

Worker invokes Claude CLI with `--append-system-prompt`, letting CLI
natively inject (via auto-discovery):
- AGENTS.md / CLAUDE.md (three layers: `~/.claude`, `~/Orb/`, `{cwd}/` = workspace/)
- Skills from `{cwd}/.claude/skills/*/SKILL.md` (per-profile via cwd) and `~/Orb/profiles/.claude/skills/*/SKILL.md` (system-scope, via worker `--add-dir profiles/`)
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

Jobs stored in `profiles/{name}/data/cron-jobs.json`. CronScheduler ticks every 60s and checks due jobs. By default jobs fork workers; `runMode: "script"` runs a shell command directly and then reuses the same delivery contract.

Job format:
```json
{
  "id": "abc123",
  "name": "Daily Report",
  "runMode": "agent",
  "prompt": "Generate daily report...",
  "command": null,
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *" },
  "deliver": { "platform": "slack", "channel": "C01234", "threadTs": null, "mode": "direct" },
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
- `"runMode"`: `"agent"` | `"script"` (default `"agent"`). Agent mode forks a worker and uses `prompt`; script mode ignores `prompt`/`model`/`effort`/`maxTurns`.
- `"command"`: required when `"runMode": "script"`; executed as `/bin/sh -c <command>` with `cwd` set to the profile workspace and stdout used as cron result text.
- `"model"`: `"haiku"` | `"sonnet"` | `"opus"` (default: system default, usually opus)
- `"effort"`: `"low"` | `"medium"` | `"high"` | `"xhigh"` | `"max"` (Opus defaults xhigh)
- `"maxTurns"`: positive integer override for Claude CLI `--max-turns`, e.g. `"maxTurns": 60`

Delivery mode is declared under `deliver.mode` (lineage: `profiles/<your-profile>/workspace/specs/cron-delivery-contract-2026-05-03.md`):

- `silent`: no success Slack post; failures still surface through the cron failure path.
- `evolution_state`: write into the evolution-state pipeline; `deliver.category` must match `profiles/<your-profile>/data/evolution/categories.yaml`.
- `dm_only`: DM-only delivery/alerting; set `deliver.onFailDM`.
- `direct`: runtime-owned channel delivery to `deliver.channel`.

Compatibility note: `~/Orb/scripts/cron/cron-deliver.sh` has been removed from cron prompt delivery and is no longer executable. Cron delivery is owned by `deliver.mode`; prompts should emit the runtime delivery JSON contract instead of calling the legacy script.

Cron workers are dispatched with IPC `channelSemantics: "silent"`, so successful worker text is suppressed by scheduler contract after any target-channel delivery. Worker `error` messages and non-success `result.stopReason` remain deliverable as failure receipts; CLI/API failures are surfaced to Karry's DM with a short cron failure title while longer stderr stays in logs/lesson-candidate context.

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

Repo boundary guard: `scripts/git-hooks/pre-commit` and `scripts/git-hooks/commit-msg` enforce lineage authorization for `src/**`, `.claude/skills/**`, `profiles/.claude/skills/**`, `package.json`, `config.json`, and `start.sh`.

### File Responsibility Layers

| File | Reader | Responsibility | Maintenance frequency |
|------|--------|----------------|----------------------|
| `~/Orb/AGENTS.md` (this file) | External Claude Code sessions (when modifying source) | Developer guide + architecture constraints | On architecture changes |
| `profiles/{name}/workspace/CLAUDE.md` | Claude CLI (auto-discovered from cwd) | Agent persona + runtime constraints + execution discipline | Regular maintenance |

Single-layer (workspace/CLAUDE.md) + CLI auto-memory: persona, decision principles, and runtime constraints all live in `workspace/CLAUDE.md`; persistent user preferences are captured by Claude CLI's native auto-memory keyed on cwd.

### Context Provider 不变量

- 任何要进 user-prompt 的「外部上下文」必须注册为 `src/context-providers/*.js`，实现 `name + prefetch` 接口
- 禁止在 `context.js` 直接拼接外部上下文字符串
- CLI 已原生覆盖的（auto-memory / cwd-discovered CLAUDE.md / cwd-discovered skills）禁止注册为 provider——避免重复注入
- provider 输出必须是 `LabeledFragment[]`（见 `specs/prompt-source-labeling-DESIGN.md`），不允许返回原始字符串

### Profile Isolation

- Each profile uses independent `scripts/`, `workspace/` (with `workspace/.claude/skills/` for per-cwd skill isolation), and `data/` paths under `profiles/{name}/`
- `userIds` mapping in `config.json` determines which profile a user belongs to; unmapped `userId`s are rejected (no `default` fallback)
- Session data is isolated by `{platform}:{threadTs}` key, stored in each profile's `data/sessions.json`
- Runtime root/path validation hard-checks `workspace/` and `data/`; `scripts/` is resolved per-profile but not enforced by the same guard
- Adding a user = create profile directory + add mapping in config.json, no source code changes

### Platform Abstraction

- SlackAdapter is the sole adapter; no abstract base required
- Required interface: `start/disconnect/sendReply/deliver/buildPayloads/cleanupIndicator/sendApproval/fetchThreadHistory` plus `botUserId`/`platform` getters. `deliver(intent, ctx)` is the single egress entry point used by `turn-delivery/orchestrator.js`; missing it breaks the whole turn delivery chain
- Optional adapter capabilities (override only when supported): `editMessage/uploadFile/setTyping/setThreadStatus/setSuggestedPrompts/startStream/appendStream/stopStream/createQiSubscriber/createPlanSubscriber/createTextSubscriber/createStatusSubscriber/sendAskUserQuestion/updateAskUserQuestionCard/clearStatusByContext`
- Platform-specific formatting in `adapters/slack-format.js`, shared utilities in `format-utils.js`
- `scheduler.js` operates the adapter only through its interface methods, never importing Slack SDKs directly
- Adding a platform = new adapter class + new format file + config.json entry + scheduler.setAdapter() call; no changes to core scheduler logic

### Worker IPC Protocol

Scheduler ↔ Worker communication via Node IPC (process.send/on('message')):

| Direction | Type | Payload | Notes |
|-----------|------|---------|-------|
| Scheduler → Worker | `task` | `{ type: 'task', userText, fileContent, imagePaths, threadTs, channel, userId, platform, teamId?, threadHistory, profile, model, effort, channelSemantics?, channelMeta?, fragments?: LabeledFragment[], origin?, maxTurns?, mode?, priorConversation?, disablePermissionPrompt?, attemptId? }` | Initial task for a thread. `teamId?` carries the Slack workspace/team id for downstream addressing (Slack-only; absent for other platforms). `attemptId` is generated by the scheduler if absent and threads through every downstream IPC payload for delivery-ledger correlation. `origin?: { kind: 'cron' \| 'inject' \| 'user' \| 'system', name: string \| null, parentAttemptId: string \| null }` tags the trigger source for replay/debug attribution. `fragments?: LabeledFragment[]` carries prompt source labeled data blocks per `specs/prompt-source-labeling-DESIGN.md`. `channelSemantics` is `'reply'` (default), `'silent'` (suppress successful worker text delivery), or reserved `'broadcast'`. `channelMeta?: { topic: string, purpose: string }` carries Slack topic/purpose for channel-level prompt constraints; empty strings are ignored. `maxTurns` overrides Claude CLI `--max-turns` for that task only. `mode: 'skill-review'` requires `priorConversation`, which `context.js` injects as review context. `disablePermissionPrompt` skips the in-process MCP permission prompt server for that task. |
| Scheduler → Worker | `inject` | `{ type: 'inject', injectId?, attemptId?, userText, fileContent?, imagePaths?, channelMeta?, fragments?: LabeledFragment[], origin? }` | Injects a follow-up user message into the active same-thread Claude CLI session without spawning a new worker. `injectId` lets the scheduler correlate acceptance/failure for fail-forward replay. `origin` is normally `{ kind: 'inject', name: 'replay', parentAttemptId }`. `fragments?: LabeledFragment[]` carries prompt source labeled data blocks per `specs/prompt-source-labeling-DESIGN.md`. `channelMeta?: { topic: string, purpose: string }` has the same semantics as task payloads. When `imagePaths` is present the worker attaches them as image content blocks before sending the turn. |
| Worker → Scheduler | `turn_start` | `{ type: 'turn_start', injectId?, attemptId? }` | Emitted immediately when the worker receives a `task` or accepted `inject`, making the scheduler the typing owner. On accepted injects the worker echoes `injectId` so the scheduler can clear the pending replay token. |
| Worker → Scheduler | `turn_end` | `{ type: 'turn_end' }` | Emitted when Claude CLI produces a `result` event for the current turn; scheduler stops typing immediately. |
| Worker → Scheduler | `turn_complete` | `{ type: 'turn_complete', text, toolCount, lastTool, stopReason, channelSemantics, gitDiffSummary?, dailyNotesSummary? }` | Signals that one Claude turn finished; scheduler can deliver final text while keeping the worker alive for future `inject` messages. `text` comes from worker `turnBuffer` (all assistant text blocks in this turn, in order, joined by `\n`); CLI `result.result` is only a last-resort fallback when the buffer is empty. Block-level dedup prevents repeated `result` lines in one turn from emitting duplicates. Scheduler drops successful text when `channelSemantics === 'silent'` and records a receipt. `gitDiffSummary` is included when the worker detected source-tree changes during the turn. `dailyNotesSummary?` carries per-turn daily-notes append counts. Both summary fields are routing-only metadata and are not rendered to Slack. |
| Worker → Scheduler | `cc_event` | `{ type: 'cc_event', turnId, attemptId?, origin?, eventType, payload }` | Raw Claude Code event forwarded to scheduler subscribers. Slack Qi, plan, text, and status rendering is driven from this stream. |
| Worker → Scheduler | `inject_failed` | `{ type: 'inject_failed', injectId?, attemptId?, userText, fileContent?, imagePaths?, channelMeta?, fragments?: LabeledFragment[], origin? }` | Follow-up inject could not reach the live CLI session (for example the session already closed). Scheduler must fail forward by replaying that payload through a fresh worker on the same thread. `fragments?: LabeledFragment[]` carries prompt source labeled data blocks per `specs/prompt-source-labeling-DESIGN.md`. `channelMeta?` and `origin?` echo the values from the failed inject so the replay task carries the same provenance. |
| Worker → Scheduler | `error` | `{ type: 'error', error, errorContext? }` | Terminal failure payload. |
| Worker → Scheduler | `result` | `{ type: 'result', text, stopReason?, channelSemantics, exitOnly: true, toolCount?, lastTool?, exitCode?, stderrSummary? }` | Worker process-exit completion signal. `text` is usually empty because final-text delivery already happened via `turn_complete`. `result` is kept for lifecycle / auto-continue / non-success `stopReason` surfacing; non-zero CLI exits set a non-success stopReason such as `api_error` / `cli_error`. |
| External → Scheduler | `external_session_result` | `{ type: 'external_session_result', channel, thread_ts, label, rc, text, took_seconds? }` | 外部 session（launcher 脚本）通过 Unix domain socket 发送。Scheduler 验证后向原 thread 投递 `launcher_result_card` 并向活跃 worker 注入摘要（`origin.kind: 'launcher_result'`）。不走 Node IPC，走 Unix socket。 |

`external_session_result` 不经 Worker IPC（process.send），而是经 Scheduler 监听的 Unix domain socket 接收。

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
- 跨 appendStream 对 `task_update.details` 的 concat 行为是 Slack 官方未明文说明但经实测稳定的路径——改动相关逻辑前先查 `profiles/<your-profile>/data/lessons/slack-stream-chunk-semantics.md`。

### Immutable Constraints

- **Claude Code CLI is the only agent runtime** — no other LLM SDKs
- **Workers are short-lived per-thread processes** — fork on first message, accept same-thread `inject` follow-ups, exit on idle timeout, never reused across threads
- **Orb runtime must not modify its own source code** — use spec files for external sessions to execute
- **config.json is the sole routing configuration source** — no hardcoded userId/profile mappings in code
