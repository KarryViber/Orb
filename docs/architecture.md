# Architecture

Orb is an orchestration layer around Claude Code CLI. The runtime boundary is simple: Claude Code remains the agent runtime, while Orb owns routing, worker lifecycle, memory recall, document search, cron scheduling, and approval relay.

## System Overview

```text
incoming message
    |
    v
adapter -> scheduler -> worker -> Claude Code CLI
              |            |
              |            +--> build Orb-managed prompt additions
              |            +--> memory bridge
              |            +--> docstore bridge
              |
              +--> permission socket server
              +--> cron scheduler
```

Main modules:

- `src/main.js`: process startup, adapter bootstrap, signals
- `src/scheduler.js`: task queueing, worker ownership, approvals, delivery
- `src/worker.js`: Claude CLI process management
- `src/context.js`: dynamic prompt additions
- `src/memory.js`: holographic and DocStore bridge calls
- `src/cron.js`: scheduled execution
- `src/mcp-permission-server.js`: MCP bridge for approval requests

## Worker Lifecycle

Orb uses short-lived workers, scoped to a single thread.

Lifecycle:

1. The scheduler receives a normalized task from an adapter.
2. It resolves the profile and forks `src/worker.js`.
3. The worker starts Claude Code in `profiles/{name}/workspace/`.
4. Follow-up messages in the same thread are sent to the live worker through `inject`.
5. After idle timeout, the worker closes Claude stdin and exits.
6. Later follow-ups start a new worker and resume from persisted Claude session state when available.

Properties of this model:

- one live worker per thread
- no worker reuse across unrelated threads
- follow-up turns can stay inside the same Claude session without rebuilding the process immediately
- exit on idle keeps background process count bounded

## Prompt Assembly

Orb deliberately keeps its own prompt surface small.

Claude Code discovers stable context natively from the workspace `cwd`:

- `~/.claude/CLAUDE.md`
- repository-root `CLAUDE.md`
- `profiles/{name}/workspace/CLAUDE.md`
- `profiles/{name}/workspace/.claude/skills/`
- `profiles/{name}/workspace/.claude/agents/`
- CLI-managed memory for that workspace

Orb injects only dynamic, request-specific layers:

- scripts path hint
- holographic recall
- DocStore recall
- thread history
- message metadata
- file content and current user message

This split keeps stable prompt material on Claude Code's side and reduces Orb-specific churn.

## IPC Protocol

Scheduler and worker communicate over Node IPC.

### Scheduler -> Worker

| Type | Payload | Purpose |
| --- | --- | --- |
| `task` | `userText`, `fileContent`, `imagePaths`, `threadTs`, `channel`, `userId`, `platform`, `threadHistory`, `profile`, `model`, `effort`, optional `mode` and `priorConversation` | Start a new turn |
| `inject` | `userText`, optional `fileContent`, optional `imagePaths` | Continue an active same-thread session |

### Worker -> Scheduler

| Type | Payload | Purpose |
| --- | --- | --- |
| `turn_start` | none | Scheduler owns typing from this point |
| `progress_update` | `text` | Todo/progress card update |
| `intermediate_text` | `text` | Mid-turn assistant text |
| `turn_end` | none | Turn finished on Claude side |
| `turn_complete` | `text`, `toolCount`, `lastTool`, `stopReason`, `segments` | Deliver one Claude turn while keeping the worker alive |
| `result` | `text`, `toolCount`, optional `lastTool`, optional `stopReason` | Final worker result before exit |
| `error` | `error`, optional `errorContext` | Terminal failure |

This is the contract that keeps scheduling concerns separate from Claude-process concerns.

## Claude CLI Session Model

The worker starts Claude Code in interactive `stream-json` mode.

Important flags:

- `--input-format stream-json`
- `--output-format stream-json`
- `--append-system-prompt` when Orb adds its small system layer
- `--resume <session-id>` when the thread already has a persisted Claude session

This is why Orb can keep native Claude sessions alive across follow-up turns without implementing a second agent protocol.

## Memory: Two Tracks, Different Jobs

Orb uses two memory systems because they solve different problems.

### Holographic Memory

Owned by Orb, stored in `profiles/{name}/data/memory.db`.

Responsibilities:

- extract structured facts from completed conversations
- rank recall by trust and relevance
- maintain fact health through purge and lint jobs
- support cross-thread recall for Orb-managed context assembly

### Claude Code Auto-Memory

Owned by Claude Code, stored under `~/.claude/projects/<encoded-cwd>/memory/`.

Responsibilities:

- native CLI memory tied to the workspace path
- persistent memory that Claude Code loads on its own

The architectural rule is that Orb does not try to reimplement Claude Code's own memory subsystem.

## DocStore

DocStore is a separate SQLite FTS5 index in `profiles/{name}/data/doc-index.db`.

Responsibilities:

- index local files through the Python bridge in `lib/docstore/`
- infer project slug from thread history when possible
- retrieve file snippets for the current request

This is document recall, not conversational memory. Keeping it separate prevents file indexing concerns from polluting the fact store.

## Cron: Fire-And-Forget

Cron jobs live in `profiles/{name}/data/cron-jobs.json`.

Execution model:

1. `src/cron.js` wakes up on its tick.
2. It loads jobs for each configured profile.
3. It computes due runs.
4. It skips jobs already marked inflight.
5. It forks a worker for the due job prompt.
6. It optionally delivers the result through the configured adapter.
7. It writes the updated next-run state back to disk.

The cron scheduler does not keep long-lived agent state. It simply spawns a worker when the job is due.

## MCP Permission Flow

Permission requests travel through a separate path from normal messages.

```text
Claude Code CLI
    |
    v
MCP permission tool
    |
    v
src/mcp-permission-server.js
    |
    v
unix socket
    |
    v
src/scheduler.js
    |
    +--> auto-allow
    |
    +--> adapter.sendApproval(...) -> user decision
```

Current behavior:

- workers create a temporary MCP config per session
- the scheduler listens on a Unix socket
- Slack is the implemented interactive approval route
- the default scheduler mode is `auto-allow` unless configured otherwise

## Invariants

These rules define the architecture and should not drift casually:

- Claude Code CLI is the only agent runtime.
- `config.json` is the source of truth for user-to-profile routing.
- Orb does not hardcode user-to-profile routing in source.
- Workers are per-thread and short-lived.
- Follow-up messages reuse a live worker only for that same thread.
- Adapter code stays behind the `PlatformAdapter` interface.
- Orb-owned context additions stay small and dynamic.
- Profile boundaries are defined by separate `scripts/`, `workspace/`, and `data/` roots.
- The running Orb daemon does not rewrite its own source tree as part of normal operation.

## Related Reads

- [../README.md](../README.md)
- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [profile-guide.md](profile-guide.md)
