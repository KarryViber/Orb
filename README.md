# Orb

Multi-profile AI agent framework — receive messages via Slack, fork [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI to execute tasks.

## What is Orb?

Orb turns Claude Code CLI into a persistent, multi-user agent accessible through messaging platforms. It receives messages from Slack (with Discord/WeChat planned), routes them to isolated user profiles, forks a Claude Code CLI process per task, and returns the results.

Each profile has its own persona, memory, skills, and workspace — complete isolation between users.

## Architecture

```
Slack/Discord/WeChat
        │
        ▼
   ┌─────────┐
   │ Adapter  │  Platform-specific message handling
   └────┬─────┘
        │
        ▼
   ┌──────────┐
   │Scheduler │  Task queue, worker lifecycle, profile routing
   └────┬─────┘
        │
        ▼
   ┌─────────┐     ┌──────────┐
   │ Worker   │────▶│Claude CLI│  One-shot forked process per task
   └─────────┘     └──────────┘
        │
   ┌────┴─────────────────┐
   │  Context Assembly     │
   │  Soul + User + Memory │
   │  + Skills + Thread    │
   └───────────────────────┘
```

## Features

- **Multi-profile isolation** — each user gets their own persona, memory, skills, scripts, and workspace
- **Holographic memory** — semantic search over conversation history, preference extraction, fact distillation
- **Cron scheduler** — recurring tasks with cron expressions, intervals, or one-shot delays
- **Platform abstraction** — add new platforms by implementing the adapter interface
- **Prompt architecture** — two-tier injection: system prompt (cacheable) + stdin (dynamic)
- **Hot reload** — `SIGHUP` reloads config without restart

## Quick Start

### Prerequisites

- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Slack workspace with a Socket Mode app

### Setup

1. **Clone and install**
   ```bash
   git clone https://github.com/KarryViber/Orb.git
   cd Orb
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your Slack app credentials
   ```

3. **Configure profiles**
   ```bash
   cp config.example.json config.json
   # Edit config.json — add your Slack user ID to a profile's userIds
   ```

4. **Create your profile**
   ```bash
   cp -r profiles/example profiles/your-name
   # Edit profiles/your-name/soul/SOUL.md — define the agent's persona
   # Edit profiles/your-name/soul/USER.md — describe yourself
   ```

5. **Start**
   ```bash
   cp start.example.sh start.sh
   chmod +x start.sh
   ./start.sh
   ```

   Or directly: `node src/main.js`

## Configuration

See [docs/configuration.md](docs/configuration.md) for full details.

**config.json** supports `${ENV_VAR}` interpolation. Send `SIGHUP` to reload without restart.

**Profile routing**: Each profile lists `userIds` — incoming messages are routed to the matching profile. Unmatched users go to `default`.

## Creating a Profile

```
profiles/your-name/
├── soul/
│   ├── SOUL.md          # Agent persona & collaboration boundaries
│   └── USER.md          # User profile (auto-synced from memory)
├── skills/              # Claude Code agent-format skill files
├── scripts/             # Utility scripts the agent can execute
├── workspace/
│   └── CLAUDE.md        # Agent runtime constraints
└── data/                # Auto-generated: sessions, memory, cron jobs
```

See [docs/profile-guide.md](docs/profile-guide.md) for details.

## How It Works

Worker calls Claude Code CLI with two injection paths:

- **`--system-prompt`**: Soul + User + MEMORY.md + Skills + Framework Directives (stable content, prompt-cache friendly)
- **`-p` (stdin)**: Holographic Recall + Thread History + Message (dynamic content per request)

This split maximizes Anthropic prompt cache hit rate — the system prompt rarely changes between requests.

## Adding Platform Adapters

Implement `PlatformAdapter` from `src/adapters/interface.js`. See [docs/adapter-development.md](docs/adapter-development.md) and `src/adapters/slack.js` as reference.

## Security Model

Orb delegates task execution to Claude Code CLI, which has full file system access within the worker's `cwd`. This means:

- **Single-profile deployment**: No additional concerns — the agent operates within your workspace.
- **Multi-profile deployment**: Each profile's agent can potentially read files outside its own workspace directory. If you run multiple profiles on the same machine with different trust levels, **isolate them in separate containers or VMs**.

### Recommendations

- Never store secrets in profile directories — use environment variables via `.env`
- Set restrictive file permissions on `profiles/*/data/` (`chmod 700`)
- For multi-user setups, run each profile in a separate container with its own filesystem
- Keep `config.json` outside the repository (it's `.gitignore`d by default)

## License

MIT — see [LICENSE](LICENSE)
