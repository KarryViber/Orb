<p align="center">
  <img src=".github/orb-logo.png" alt="Orb" width="160" />
</p>

<h1 align="center">Orb</h1>

<p align="center">A self-evolving AI agent framework that wraps <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> CLI with persistent memory, multi-profile isolation, and messaging platform integration.</p>

> **Why Claude Code?** Orb doesn't reimplement an agent runtime — it orchestrates Claude Code CLI as-is. Every Claude Code update (new models, tools, capabilities) flows into Orb automatically. Zero migration cost.

## What Orb Does

```
You (Slack) → Orb → Claude Code CLI → results back to you
```

Orb sits between your messaging platform and Claude Code. It adds what Claude Code doesn't have out of the box:

- **Persistent memory** that grows across conversations
- **Identity & persona** that stays consistent
- **Multi-user routing** — one Orb instance, multiple people
- **Scheduled tasks** — cron jobs that run Claude Code on a schedule
- **Document knowledge** — local file indexing with automatic context retrieval

## Architecture

```
  Slack / Discord / WeChat
            │
            ▼
     ┌────────────┐
     │   Adapter   │  Normalize platform messages
     └──────┬──────┘
            │
            ▼
     ┌────────────┐     ┌──────────────┐
     │  Scheduler  │────▶│  Cron Engine  │  Scheduled tasks
     └──────┬──────┘     └──────────────┘
            │
            ▼
     ┌────────────┐     ┌──────────────┐
     │   Worker    │────▶│  Claude Code  │  One-shot fork per task
     └──────┬──────┘     └──────────────┘
            │
     ┌──────┴──────────────────────────┐
     │         Context Assembly         │
     │                                  │
     │  ┌──────────────┐ ┌────────────┐│
     │  │ CLAUDE Layers │ │ Auto-memory││
     │  └──────────────┘ └────────────┘│
     │  ┌──────────────┐ ┌────────────┐│
     │  │ Skills/Agents │ │ DocStore   ││
     │  └──────────────┘ └────────────┘│
     └─────────────────────────────────┘
```

## Key Features

### Holographic Memory

A local, embedding-free memory system built on [Holographic Reduced Representations](https://en.wikipedia.org/wiki/Holographic_reduced_representation) (HRR) + SQLite FTS5.

- **Local-first storage** — all facts live in a local SQLite DB; retrieval runs on-device. The only outbound call is a small Haiku arbitration per write, routed through the same Claude Code CLI the agent itself uses (no extra SDK, no separate API key).
- **Three retrieval modes**: keyword (FTS5/BM25), token overlap (Jaccard), and algebraic (HRR phase vectors) — combined via hybrid scoring
- **Automatic fact extraction** — conversations are decomposed into categorized facts (preferences, decisions, knowledge, lessons)
- **Write-time LLM arbitration** — on each new fact, top-3 near-neighbors are retrieved and a Haiku call decides `ADD` / `UPDATE` / `DELETE` / `NONE` (inspired by [mem0](https://github.com/mem0ai/mem0)). Conflicts are resolved at write time, not by time-based decay.
- **Bi-temporal tombstones** — superseded facts are never hard-deleted; they get `invalid_at` + `superseded_by` pointers (inspired by [Graphiti](https://github.com/getzep/graphiti)). Reads filter to valid facts by default; audit queries can surface history.
- **Frozen trust scores** — trust is set once at write time from extractor confidence (`confirmed` / `default` / `speculative`), then only moved by explicit user feedback. No exponential decay to quietly erase rarely-retrieved-but-true facts (birthdays, preferences).
- **Transient-only hard delete** — only ephemeral categories (`session_context`, `transient_state`) are purged by age (7-day default). Durable knowledge is kept forever behind tombstones.
- **Self-healing** — daily memory-lint detects orphaned facts and duplicates. Fail-open arbitration: if the CLI call errors or times out (5s), the fact is stored as `ADD` rather than dropped — memory never blocks the hot path.

### Self-Evolution

Orb learns from every interaction and refines itself automatically:

1. **Fact extraction** — each conversation → categorized facts (preference, decision, lesson, knowledge, entity)
2. **Error distillation** — mistakes → actionable lessons ("what to do differently", not "what went wrong")
3. **Correction capture** — user corrections → preference facts with asymmetric trust scoring (penalties > rewards)
4. **Holographic consolidation** — high-trust facts remain queryable in local `memory.db`, and contradictions tombstone older facts instead of silently coexisting
5. **Claude Code auto-memory** — durable profile-specific memory is managed by Claude Code CLI under `~/.claude/projects/<encoded-cwd>/memory/`

The result: the agent gets better at working with you over time, without you explicitly teaching it.

### Document Knowledge (DocStore)

Local file indexing with FTS5 full-text search:

- **Supported formats**: Markdown, DOCX, PDF
- **Semantic chunking**: 300-1200 char chunks with heading-aware boundaries and overlap
- **Priority weighting**: delivery docs (1.5x) > source docs (1.2x) > meetings (1.0x) > drafts (0.6x)
- **Thread-scoped retrieval**: automatically infers which project a conversation is about and narrows search

### Multi-Profile Isolation

Each user gets a fully isolated environment:

```
profiles/your-name/
├── scripts/        # Utility scripts the agent can call
├── workspace/      # Claude Code working directory (cwd per profile)
│   ├── CLAUDE.md   # Persona + runtime constraints
│   └── .claude/
│       ├── skills/ # Per-profile Claude Code skills
│       └── agents/ # Optional agents discovered by CLI
└── data/           # Sessions, memory DB, cron jobs (auto-generated)
```

Profiles don't share memory, sessions, or workspace. One Orb instance can serve multiple users with completely different personas.

Legacy `soul/` files and `profiles/*/data/MEMORY.md` are retired. Persona now lives in `profiles/{name}/workspace/CLAUDE.md`, and persistent memory is handled by Claude Code CLI auto-memory keyed on the workspace `cwd`.

### Prompt Cache Optimization

Orb keeps its own prompt additions minimal and lets Claude Code discover the stable layers natively, which maximizes [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching):

| Layer | Injected via | Content | Cache behavior |
|------|-------------|---------|----------------|
| **CLI auto-discovery** | Claude Code native discovery | `~/.claude/CLAUDE.md` + `~/Orb/CLAUDE.md` + `{cwd}/CLAUDE.md`, per-workspace skills, agents, auto-memory | Stable — high cache hit rate |
| **Orb appended system prompt** | `--append-system-prompt` | Scripts path pointer | Stable — minimal diff surface |
| **Orb user prompt** | stdin (`-p` / stream-json) | Holographic recall + Doc results + Thread history + Message | Dynamic — changes per request |

Stable layers stay nearly identical between turns, so prompt cache locality remains high without Orb maintaining a custom multi-file system prompt stack.

### Cron Scheduler

Schedule recurring Claude Code tasks:

- **Cron expressions**: `0 9 * * *` (daily at 9am)
- **Intervals**: `every 30m`
- **One-shot delays**: `2h`, ISO timestamps
- **Delivery routing**: results sent to specific Slack channels/threads
- **Managed via file**: agents read/write `cron-jobs.json` directly

### Platform Adapters

Abstract messaging platform interface. Currently supported:

- **Slack** (Socket Mode) — full support including threads, files, Block Kit, approval flows
- **WeChat** — experimental

Adding a new platform = implement `PlatformAdapter` interface + format module. No changes to scheduler/worker/context.

## Quick Start

### Prerequisites

- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Python 3.9+ with numpy (for holographic memory)
- A Slack workspace with a [Socket Mode app](https://api.slack.com/apis/socket-mode)

### Setup

```bash
# Clone and install
git clone https://github.com/KarryViber/Orb.git
cd Orb && npm install

# Configure
cp .env.example .env               # Add your Slack credentials
cp config.example.json config.json  # Add your user ID

# Create your profile
cp -r profiles/example profiles/your-name
# Edit profiles/your-name/workspace/CLAUDE.md — persona + runtime constraints

# Start
node src/main.js
```

Legacy `soul/` files in older profiles are retired after the Claude Code CLI migration.

Then message your Slack bot. Orb routes the message to your profile, lets Claude Code assemble its native context layers (`CLAUDE.md` + skills/agents + auto-memory), adds Orb recall/docs context, forks Claude Code, and sends the response back.

## Configuration

`config.json` supports `${ENV_VAR}` interpolation. Sending `SIGHUP` only re-reads `config.json` and refreshes the cron scheduler's profile-name set. It does not rebuild adapters, rotate adapter tokens, reconnect an existing Slack Socket Mode session, restart active workers, or apply already-running scheduler parameters such as worker limits and timeouts. Restart the daemon for full effect.

```jsonc
{
  "adapters": {
    "slack": {
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}",
      "signingSecret": "${SLACK_SIGNING_SECRET}"
    }
  },
  "profiles": {
    "default": {
      "userIds": ["U0YOUR_SLACK_ID"],
      "freeResponseChannels": ["C0CHANNEL_ID"],
      "freeResponseUsers": []
    }
  }
}
```

See [docs/configuration.md](docs/configuration.md) for full reference.

## How It Works

1. **Message arrives** via Slack Socket Mode
2. **Adapter normalizes** the message (extracts text, files, thread context)
3. **Scheduler routes** to the correct profile based on `userIds` mapping
4. **Context assembly** combines Claude Code native discovery with Orb additions:
   - Claude Code auto-discovers `~/.claude/CLAUDE.md`, `~/Orb/CLAUDE.md`, `{workspace}/CLAUDE.md`, per-workspace skills/agents, and auto-memory
   - Orb appends the scripts path pointer and streams holographic recall (top 5), DocStore results (top 5), thread history, and the current message
5. **Worker forks** Claude Code CLI with assembled context as a one-shot process
6. **Response streams** back: text → Slack, files → uploaded, approvals → interactive buttons
7. **Post-processing**: conversation stored → facts extracted → memory updated

## Security Model

Orb delegates execution to Claude Code CLI, which has file system access within its working directory.

- **Single-user**: No additional concerns — standard Claude Code security model
- **Multi-user on same machine**: Profiles are logically isolated but share OS-level access. For different trust levels, **run each profile in a separate container**.

Best practices:
- Store secrets in `.env` (gitignored), never in profile directories
- Set `chmod 700` on `profiles/*/data/`
- `config.json` is gitignored by default

## Contributing

Contributions welcome. Key areas:

- **New adapters** — Discord, Telegram, LINE, etc.
- **Memory improvements** — better extraction, richer arbitration prompts, smarter near-neighbor selection
- **Documentation** — guides, examples, translations

## License

[MIT](LICENSE)
