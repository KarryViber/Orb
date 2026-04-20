# Getting Started

This guide walks through the first usable Orb deployment: one Slack app, one profile, one Claude Code workspace.

## Prerequisites

- Node.js 18 or newer
- Python 3.11 or newer
- Claude Code CLI installed and authenticated
- A Slack workspace where you can create a Socket Mode app

Claude Code CLI docs: https://code.claude.com/docs/

Before touching Orb, make sure the CLI itself works:

```bash
claude
```

If that command fails, fix Claude Code installation and authentication first.

## 1. Clone And Install

```bash
git clone https://github.com/KarryViber/Orb.git
cd Orb
npm install
cp .env.example .env
cp config.example.json config.json
```

The repository example files are only starters. A runnable `config.json` still needs enabled adapters and explicit profile paths.

## 2. Create A Slack App

Orb's documented production path is Slack Socket Mode.

In your Slack app settings:

1. Enable Socket Mode and create an app-level token with the `connections:write` scope.
2. Add bot token scopes that cover reading messages and writing replies. A practical minimum is `app_mentions:read`, `channels:history`, `chat:write`, `files:write`, `im:history`, and `im:write`.
3. Subscribe to the message events you want Orb to receive. For a basic setup, `app_mention`, `message.channels`, and `message.im` are the relevant ones.
4. Install the app to the workspace.
5. Copy the bot token and app token into `.env`.

Minimal `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

Optional environment variables that matter early:

- `CLAUDE_PATH` if the CLI binary is not on `PATH`
- `CLAUDE_MODEL` to set a default model
- `ORB_PERMISSION_APPROVAL_MODE=slack` if you want Slack approval cards instead of auto-allow
- `PYTHON_PATH` if `python3` is not the right interpreter on your machine

## 3. Create Your First Profile

Orb does not need source changes for a new user. A profile is just directories plus a `config.json` entry.

Create the directory structure:

```bash
mkdir -p profiles/alice/scripts
mkdir -p profiles/alice/workspace/.claude/skills
mkdir -p profiles/alice/workspace/.claude/agents
mkdir -p profiles/alice/data
cp profiles/example/workspace/CLAUDE.md profiles/alice/workspace/CLAUDE.md
```

Edit `profiles/alice/workspace/CLAUDE.md` so the workspace has the persona and runtime rules you actually want Claude Code to load.

## 4. Write config.json

Minimal Slack setup:

```json
{
  "adapters": {
    "slack": {
      "enabled": true,
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}"
    }
  },
  "profiles": {
    "alice": {
      "userIds": ["U0123456789"],
      "scripts": "./profiles/alice/scripts",
      "workspace": "./profiles/alice/workspace",
      "data": "./profiles/alice/data"
    }
  },
  "scheduler": {
    "maxWorkers": 3,
    "timeoutMs": 900000
  }
}
```

Important routing rule: Orb matches users only through `profiles.{name}.userIds`. Unmapped users are rejected. Older example configs that imply a fallback profile do not reflect the current resolver.

## 5. Start Orb

For a normal foreground run:

```bash
npm start
```

For local iteration with restart-on-change:

```bash
npm run dev
```

Orb starts the enabled adapters, brings up the scheduler, opens the permission socket, and then begins accepting messages.

## 6. Send The First Message

Use Slack to DM the bot or message it in a route the adapter is configured to accept.

Minimal test:

1. Send `hello`
2. Orb resolves your Slack user ID to `alice`
3. The scheduler forks a worker for that thread
4. The worker starts Claude Code in `profiles/alice/workspace/`
5. Claude replies in Slack

If you see a reply, the full path is working:

- Slack event ingestion
- profile routing
- worker fork
- Claude Code launch
- result delivery

## 7. Optional: Run Under launchd On macOS

`start.sh` is the simple wrapper intended for managed startup.

```bash
cp start.example.sh start.sh
chmod +x start.sh
```

Example `~/Library/LaunchAgents/com.orb.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.orb.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/you/Orb/start.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Orb/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Orb/logs/stderr.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.orb.agent.plist
```

## Troubleshooting

### Claude Code launches, but permission approval never shows up

Check these first:

- `ORB_PERMISSION_APPROVAL_MODE=slack` is set if you expect interactive approval
- the message came from a platform and channel the scheduler can route back to
- `claude` is installed and available to the Node worker

Orb writes a temporary MCP config for each worker and forwards approvals through `src/mcp-permission-server.js`. If the worker falls back to auto-allow, the environment is usually the reason.

### Slack never connects

Check:

- `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
- Socket Mode is enabled in the app
- the adapter entry in `config.json` has `"enabled": true`

Run Orb in the foreground first so connection errors appear directly in the terminal.

### The worker exits before replying

Look at:

- `logs/stdout.log`
- `logs/stderr.log`

Common causes:

- Claude Code is not authenticated
- the profile `workspace` path is wrong
- Python is missing for the memory or DocStore bridge
- the user is not mapped in `config.json`

### A follow-up message starts a new conversation instead of continuing

Orb resumes by thread key. If the platform thread ID changes, or if the previous worker has already idled out, Orb starts a fresh worker and resumes from stored Claude session data only if that session was persisted successfully.

## Next Reads

- [configuration.md](configuration.md)
- [profile-guide.md](profile-guide.md)
- [architecture.md](architecture.md)
