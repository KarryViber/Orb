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
  context.js           — Layered prompt assembly (soul → user → directives → memory → thread → message)
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

- `profiles/{name}/soul/`      — Persona / collaboration boundaries / user profile (per-profile, read-only at runtime)
- `profiles/{name}/skills/`    — Skill files (Claude Code native agent format, scanned and indexed by context.js)
- `profiles/{name}/scripts/`   — User utility scripts
- `profiles/{name}/workspace/` — Claude CLI working directory
- `profiles/{name}/data/`      — sessions.json + memory.db + doc-index.db + cron-jobs.json + MEMORY.md (gitignored)
- `lib/holographic/`           — Holographic memory engine (Python)
- `lib/docstore/`              — DocStore file index (FTS5, Python)
- `config.json`                — Profile routing + adapter configuration

## Prompt Architecture

Worker invokes Claude CLI with two injection paths:
- `--system-prompt`: Soul + User + MEMORY.md + Skills + Framework Directives (stable content, prompt-cache friendly)
- `-p` (stdin): Holographic Recall + Docs + Thread History + Message (dynamic content)

Soul files: SOUL.md (persona + collaboration boundaries) + USER.md (user profile). workspace/CLAUDE.md is auto-read by CLI from cwd (runtime constraints + execution discipline). USER.md is auto-synced by scheduler from holographic preference facts. MEMORY.md lives in data/, written by the agent + periodically merged from high-trust facts by scheduler. Framework directives (memory strategy, etc.) are hardcoded in context.js and conditionally injected.

## Config

`config.json` supports `${ENV_VAR}` interpolation. SIGHUP triggers hot-reload.

## Dev

```bash
npm run dev          # --watch mode
npm start            # Production start (managed by launchd)
```

## Conventions

- ESM (type: module), Node >= 18, pure JS
- Workers are one-shot forks — execute and exit, never reused
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
  "nextRunAt": "2026-04-15T09:00:00+09:00",
  "lastRunAt": null, "lastStatus": null, "lastError": null
}
```

Schedule types: `"0 9 * * *"` (cron), `"every 30m"` (interval), `"2h"` / ISO (one-shot).
Agents manage tasks by directly reading/writing cron-jobs.json (Claude CLI native file operations).

---

## Architecture Constraints

The following rules are invariants established during architecture evolution. Any session modifying source code must comply.

### File Responsibility Layers

| File | Reader | Responsibility | Maintenance frequency |
|------|--------|----------------|----------------------|
| `~/Orb/CLAUDE.md` (this file) | External Claude Code sessions (when modifying source) | Developer guide + architecture constraints | On architecture changes |
| `profiles/{name}/workspace/CLAUDE.md` | Orb worker (Claude CLI's cwd) | Agent runtime constraints + execution discipline | Rarely changes |
| `profiles/{name}/soul/SOUL.md` | Orb worker (read by context.js) | Persona + collaboration boundaries | Regular maintenance |
| `profiles/{name}/soul/USER.md` | Orb worker (read by context.js) | User profile | Auto-synced |

Two-layer separation + framework built-in directives: soul = identity + decision principles, workspace CLAUDE.md = operational constraints, framework directives = hardcoded operational mechanisms in context.js (conditionally injected).

### Profile Isolation

- Each profile owns independent `soul/`, `skills/`, `scripts/`, `workspace/`, `data/` directories
- `userIds` mapping in `config.json` determines which profile a user belongs to
- `default` profile is the fallback for unmapped users
- Session data is isolated by `{platform}:{threadTs}` key, stored in each profile's `data/sessions.json`
- Adding a user = create profile directory + add mapping in config.json, no source code changes

### Platform Abstraction

- `adapters/interface.js` defines the `PlatformAdapter` abstract base class
- One adapter per platform (slack.js), implementing `start/disconnect/sendReply/editMessage/uploadFile/setTyping/sendApproval/buildPayloads/fetchThreadHistory`
- Platform-specific formatting in `adapters/{platform}-format.js`, shared utilities in `format-utils.js`
- `scheduler.js` operates platforms only through the adapter interface, never importing platform SDKs directly
- Adding a platform = new adapter + format file + config.json entry, no changes to scheduler/worker/context

### Worker IPC Protocol

Scheduler ↔ Worker communication via Node IPC (process.send/on('message')):

```
Scheduler → Worker:
  { type: 'task', userText, fileContent, threadTs, channel, userId, platform, threadHistory, profile }
  { type: 'approval_result', approved, scope, userId }

Worker → Scheduler:
  { type: 'result', text }
  { type: 'error', error }
  { type: 'update', text, messageTs }
  { type: 'file', filePath, filename }
  { type: 'approval', prompt }
```

Adding new message types requires updating both the worker.js header comment and the scheduler.js handler.

### Immutable Constraints

- **Claude Code CLI is the only agent runtime** — no other LLM SDKs
- **Workers are one-shot processes** — execute and exit, never reused
- **Orb runtime must not modify its own source code** — use spec files for external sessions to execute
- **config.json is the sole routing configuration source** — no hardcoded userId/profile mappings in code
