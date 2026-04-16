# Configuration

## config.json

The main configuration file. Copy from `config.example.json` and never commit the real file (it's `.gitignore`d).

Supports `${ENV_VAR}` interpolation — values like `"${SLACK_BOT_TOKEN}"` are expanded from environment variables at startup.

Send `SIGHUP` to reload without restarting: `kill -HUP $(pgrep -f "node src/main.js")`

### Full Schema

```json
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
      "userIds": [],
      "freeResponseChannels": [],
      "freeResponseUsers": []
    },
    "alice": {
      "userIds": ["U01234ABCDE"],
      "freeResponseChannels": ["C09876FGHIJ"],
      "freeResponseUsers": []
    }
  },
  "claudePath": "claude",
  "maxConcurrentWorkers": 2
}
```

### Profile Routing

- `userIds`: Slack user IDs routed to this profile. Find yours in Slack profile → More → Copy member ID.
- `freeResponseChannels`: Channels where the bot responds without an `@mention`.
- `freeResponseUsers`: User IDs that can DM the bot without `@mention`.
- `default`: Fallback profile for users not listed in any other profile.

### Top-Level Fields

| Field | Default | Description |
|-------|---------|-------------|
| `claudePath` | `"claude"` | Path to Claude Code CLI binary |
| `maxConcurrentWorkers` | `2` | Max simultaneous worker processes |

## Environment Variables (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Request signing secret |
| `CLAUDE_PATH` | No | Override Claude CLI path |
| `CLAUDE_MODEL` | No | Default model (e.g. `claude-sonnet-4-6`) |
| `MAX_TURNS` | No | Max agent turns per task (default: 50) |
| `MAX_WORKERS` | No | Override max concurrent workers |
| `MEMORY_ENABLED` | No | Enable holographic memory (default: true) |
| `PYTHON_PATH` | No | Python binary for memory engine (default: python3) |
| `REPLY_BROADCAST` | No | Also post replies to main channel (default: false) |

## Holographic Memory

Requires Python 3.9+ and the deps in `lib/holographic/requirements.txt`:

```bash
pip install -r lib/holographic/requirements.txt
```

Memory is stored per-profile in `profiles/{name}/data/memory.db`. The agent can recall past facts semantically and distill high-trust facts into `MEMORY.md` (injected into system prompt).

To disable: set `MEMORY_ENABLED=false` in `.env`.

## DocStore

Requires Python 3.9+ and the deps in `lib/docstore/requirements.txt`. Enables the agent to search indexed project documentation.

Configure `DOC_REGISTRY_PATH` or `DOC_PROJECTS_ROOT` env vars to point to your registry file.
