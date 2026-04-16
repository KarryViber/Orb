# Getting Started

## Prerequisites

- **Node.js >= 18** — [nodejs.org](https://nodejs.org)
- **Claude Code CLI** — [installation guide](https://docs.anthropic.com/en/docs/claude-code)
  - Must be authenticated: run `claude` once and complete the auth flow
- **Slack workspace** with a Socket Mode app — [create an app](https://api.slack.com/apps)

## Installation

```bash
git clone https://github.com/KarryViber/Orb.git
cd Orb
npm install
```

## Slack App Setup

In your Slack app settings:

1. **Socket Mode** → Enable Socket Mode, generate an App-Level Token (`xapp-...`) with `connections:write` scope
2. **OAuth & Permissions** → Add Bot Token Scopes:
   - `app_mentions:read`, `channels:history`, `chat:write`, `files:write`, `im:history`, `im:write`, `reactions:write`
3. **Event Subscriptions** → Subscribe to bot events: `app_mention`, `message.channels`, `message.im`
4. **Install App** → Install to workspace, copy the Bot Token (`xoxb-...`)
5. **Basic Information** → Copy the Signing Secret

## Environment Configuration

```bash
cp .env.example .env
```

Edit `.env`:
```env
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
SLACK_SIGNING_SECRET=your-secret
```

## Profile Setup

```bash
cp config.example.json config.json
cp -r profiles/example profiles/your-name
```

Edit `config.json` to add your Slack user ID:
```json
{
  "profiles": {
    "your-name": {
      "userIds": ["U01234ABCDE"]
    },
    "default": {
      "userIds": []
    }
  }
}
```

Edit `profiles/your-name/soul/SOUL.md` to define the agent's persona.

## Starting Orb

```bash
cp start.example.sh start.sh
chmod +x start.sh
./start.sh
```

Or directly:
```bash
node src/main.js
```

## Verifying It Works

1. Invite the bot to a Slack channel: `/invite @your-bot-name`
2. Send a message mentioning the bot: `@your-bot-name hello`
3. The bot should respond within a few seconds

Check logs for issues:
```bash
tail -f logs/stdout.log
```

## Running as a System Service (macOS)

Create a launchd plist at `~/Library/LaunchAgents/com.orb.claude-agent.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.orb.claude-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/Orb/start.sh</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/path/to/Orb/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/Orb/logs/stderr.log</string>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/com.orb.claude-agent.plist
```
