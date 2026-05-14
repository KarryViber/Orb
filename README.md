<p align="center">
  <img src=".github/orb-logo.png" alt="Orb" width="160" />
</p>

# Orb

> A multi-profile messaging shell around Claude Code CLI.

## What Orb Is

Orb receives messages from a platform adapter, routes them to the right profile, starts or resumes a per-thread Claude Code CLI session, and sends the result back. Orb does not replace Claude Code's runtime. It supplies routing, profile isolation, long-term recall, document search, cron execution, and approval handling around the native CLI.

```text
You (Slack DM / thread)
        |
        v
      Orb
        |
        v
Claude Code CLI (one worker per thread, cwd = profiles/{name}/workspace/)
        |
        v
      Reply
```

## Why Claude Code Native

- Claude Code already auto-discovers `CLAUDE.md`, workspace skills, workspace agents, and CLI-managed memory from the current working directory.
- Orb stays outside the agent runtime. It handles message routing, context assembly, profile boundaries, cron orchestration, and permission relay.
- Claude Code upgrades land without a prompt-stack migration inside Orb.
- The worker process talks to Claude Code over native `stream-json`, so Orb can reuse sessions for follow-up turns in the same thread instead of rebuilding an agent loop of its own.

## Features

- Multi-profile isolation with separate `scripts/`, `workspace/`, and `data/` directories per profile.
- Slack Socket Mode adapter for production use. The `PlatformAdapter` abstraction stays, but Orb ships a single Slack instance; alternative platforms would require a custom adapter.
- Holographic long-term memory in local SQLite for fact extraction, trust scoring, decay controls, and write-time arbitration.
- DocStore full-text search in local SQLite FTS5, with project slug inference from the thread and registry-driven path mapping.
- Cron scheduling with per-profile `cron-jobs.json`, fire-and-forget workers, and per-job inflight guards.
- MCP permission relay that can surface Claude Code approval requests in Slack.
- Short-lived per-thread workers that reuse the same Claude session for follow-up messages via `inject` IPC.


## v0.6 Highlights

- Single-adapter consolidation: the `PlatformAdapter` registry collapses to a single Slack instance. The WeChat adapter and its iLink CDN bridge are removed; the abstraction stays so a new adapter can still slot in cleanly.
- Self-evolution cron is refactored into a three-stage pipeline: **A — mechanical** (deterministic data gathering, no LLM), **B — single-pass LLM** (one reasoning pass), **C — render** (deterministic card formatting). Each stage owns one failure mode and one model budget.
- Lesson lifecycle automation: distill, narration audit, candidate auto-classify (new vs. merge), and weekly seed-landing approval share one canonical audit pass at 02:20 JST. Lesson similarity comparison swaps Jaccard for a Haiku LLM judge.
- Four-layer `CLAUDE.md` prompt architecture: `~/.claude/CLAUDE.md` (user-private) / repo-root `CLAUDE.md` / `profiles/CLAUDE.md` (framework-wide engineering rules) / `profiles/{name}/workspace/CLAUDE.md` (profile-specific). Framework rules moved up from user-private into the repo so all profiles inherit them.
- Slack signal-to-noise rebalance: auto-context injection (`git diff` + daily-notes receipt) is opt-in via `ORB_SLACK_AUTO_CONTEXT=1`; proactive stream rotation at 4 minutes is the default (`ORB_STREAM_AUTO_ROTATE=1`).

## Quickstart

Prerequisites:

- Node.js 18 or newer
- Python 3.11 or newer
- Claude Code CLI installed and authenticated
- A Slack app with Socket Mode enabled

Install and start:

```bash
git clone https://github.com/KarryViber/Orb.git
cd Orb
npm install
cp .env.example .env
cp config.example.json config.json
```

Create your first profile:

```bash
mkdir -p profiles/alice/scripts
mkdir -p profiles/alice/workspace/.claude/skills
mkdir -p profiles/alice/data
cp profiles/example/workspace/CLAUDE.md profiles/alice/workspace/CLAUDE.md
```

Fill in `.env` and `config.json`, then start Orb:

```bash
npm start
```

Send the Slack bot a DM. If routing, Claude authentication, and Socket Mode are all correct, Orb will start a worker for that thread and return the reply in Slack.

The full walkthrough lives in [docs/getting-started.md](docs/getting-started.md).

## Architecture At A Glance

```text
src/main.js
   |
   +--> adapters/* ------------------------------+
   |                                             |
   +--> src/cron.js                              |
   |        |                                    |
   |        +--> spawn cron worker --------------+
   |                                             |
   +--> src/scheduler.js <---- unix socket ---- src/mcp-permission-server.js
              |                                       ^
              |                                       |
              +--> fork src/worker.js per thread -----+
                        |
                        +--> Claude Code CLI
                        |      cwd = profiles/{name}/workspace/
                        |      auto-discovers:
                        |      - ~/.claude/CLAUDE.md
                        |      - ./CLAUDE.md
                        |      - workspace/CLAUDE.md
                        |      - workspace/.claude/skills/
                        |      - workspace/.claude/agents/
                        |      - CLI-managed memory
                        |
                        +--> sidecars
                               - lib/holographic/*  -> memory.db
                               - lib/docstore/*     -> doc-index.db
```

The deeper walkthrough is in [docs/architecture.md](docs/architecture.md).

## Prompt Architecture

Claude Code discovers the stable layers natively:

- Layer 1: `~/.claude/CLAUDE.md` (user-private global)
- Layer 2: repository-root `CLAUDE.md` (project-wide rules)
- Layer 3: `profiles/CLAUDE.md` (framework-level engineering rules; loaded into every profile worker via cwd walk-up)
- Layer 4: `profiles/{name}/workspace/CLAUDE.md` (profile-specific)
- Workspace add-ons: `profiles/{name}/workspace/.claude/skills/` and `profiles/{name}/workspace/.claude/agents/`
- System-scope skills shared across profiles: `profiles/.claude/skills/` (loaded into every worker via `--add-dir`)
- CLI-managed memory tied to the workspace `cwd`

Orb only adds what the CLI does not already know:

- A minimal appended system prompt with the profile's `scripts/` path
- Holographic memory recall from `profiles/{name}/data/memory.db`
- DocStore recall from `profiles/{name}/data/doc-index.db`
- Thread history supplied by the adapter
- Thread metadata, file text, and the current user message

## Memory Subsystems

Orb uses two memory tracks plus document recall:

- Holographic memory: a local fact store in `profiles/{name}/data/memory.db`, used for extraction, trust-weighted recall, contradiction handling, and memory hygiene jobs.
- Claude Code auto-memory: the CLI's own persistent memory store, keyed by the profile workspace path under `~/.claude/projects/<encoded-cwd>/memory/`.
- DocStore: a separate file index in `profiles/{name}/data/doc-index.db` with FTS5 search and project slug scoping.

The important split is architectural: Orb owns cross-thread factual recall and document lookup, while Claude Code owns its native persistent memory for the workspace.

## Cron

Each profile can keep scheduled jobs in `profiles/{name}/data/cron-jobs.json`. The cron scheduler reads the file, computes due runs, forks a worker, and optionally delivers the result back through an adapter.

Example job:

```json
{
  "id": "daily-report",
  "name": "Daily Report",
  "prompt": "Summarize today's open work items.",
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "display": "0 9 * * *"
  },
  "deliver": {
    "platform": "slack",
    "channel": "C0123456789",
    "threadTs": null
  },
  "profileName": "alice",
  "enabled": true,
  "model": "haiku",
  "effort": "low"
}
```

Suggested model tiers:

| Task type | Model | Effort |
| --- | --- | --- |
| Scripted or templated output | `haiku` | `low` |
| Summaries and routine aggregation | `sonnet` | `medium` |
| Decision review or knowledge distillation | `sonnet` | `high` |
| Deep analysis | `opus` | `xhigh` |

## Permission Model

When Claude Code requests approval for an action outside the worker's default allowlist, Orb can relay that request through an MCP permission tool:

- The worker writes a temporary MCP config and starts Claude Code with `--permission-prompt-tool`.
- `src/mcp-permission-server.js` forwards the request over a Unix socket to `src/scheduler.js`.
- The scheduler either auto-allows or sends an approval card through the active adapter.
- Slack is the implemented interactive approval route today.

Orb also seeds `profiles/{name}/workspace/.claude/settings.json` on demand with a conservative allowlist for common read-only and inspection commands.

## Profiles

A profile is a complete Claude working environment:

```text
profiles/{name}/
├── scripts/
├── workspace/
│   ├── CLAUDE.md
│   └── .claude/
│       ├── skills/
│       └── agents/
└── data/
    ├── sessions.json
    ├── memory.db
    ├── doc-index.db
    └── cron-jobs.json
```

See [docs/profile-guide.md](docs/profile-guide.md) for the full profile model.

## Adding A Platform

New platforms plug in through the `PlatformAdapter` shape declared in `src/adapters/slack.js`. Orb keeps formatting, transport, and approval handling behind the adapter boundary so scheduler and worker code do not need platform-specific imports.

See [docs/adapter-development.md](docs/adapter-development.md).

## Project Layout

```text
src/
├── main.js                # adapter startup, scheduler, signals
├── scheduler.js           # worker lifecycle, queueing, approvals
├── worker.js              # Claude CLI session management
├── cron.js                # scheduled jobs
├── context.js             # Orb-managed prompt additions (delegates to providers)
├── context-providers/     # holographic / docstore / thread-history / skill-review
├── turn-delivery/         # per-turn delivery orchestration (intents, ledger, status, streams)
├── memory.js              # holographic + docstore bridges
├── session.js             # thread -> Claude session persistence
├── ipc-schema.js          # worker <-> scheduler IPC payload schema
├── stop-reason.js         # unified stopReason classification
├── format-utils.js        # adapter-agnostic text helpers
└── adapters/
    ├── slack.js                       # the single PlatformAdapter instance
    ├── slack-format.js
    ├── slack-permission-render.js
    ├── slack-stream-error.js
    ├── slack-block-actions.js
    ├── slack-block-action-card.js
    ├── slack-block-action-script.js
    ├── slack-dm-routing.js
    └── image-cache.js

lib/
├── holographic/           # Python memory bridge and maintenance
├── docstore/              # Python FTS5 index and search bridge
├── lesson-distill/        # lesson candidate distillation
└── memory-usage/          # memory usage tracking + decay

scripts/
├── cron/                  # channel resolve, run log, narration audit, run mode = script
├── slack/                 # blockkit, send-thread, send-attachment, extract
├── infra/                 # cleanup, mac health, memory lint, outbound gate
├── workflow/              # external-session-spawn, claudemd-lint, memory-crud
├── git-hooks/             # pre-commit boundary guard
└── hooks/                 # PreToolUse / docstore hint hooks

profiles/
├── CLAUDE.md              # framework-level engineering rules (Layer 3)
├── .claude/skills/        # system-scope skills shared across profiles
└── {name}/                # scripts + workspace + data per profile
```

## Status

- Slack adapter: production path
- Other platforms: not implemented; contributions welcome via the `PlatformAdapter` interface

## License

[MIT](LICENSE)
