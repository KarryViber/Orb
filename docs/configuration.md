# Configuration

Orb reads one runtime config file, `config.json`, and interpolates `${ENV_VAR}` values before startup. This document describes the schema that the current code actually uses.

## Overview

`config.json` has three top-level sections:

- `adapters`: enabled messaging transports and their platform-specific settings
- `profiles`: user routing and on-disk paths for each Claude workspace
- `scheduler`: worker concurrency and timeout settings

Environment variable interpolation is exact-match only:

```json
{
  "botToken": "${SLACK_BOT_TOKEN}"
}
```

`"${SLACK_BOT_TOKEN}"` is expanded, but `"token:${SLACK_BOT_TOKEN}"` is not.

## Full Example

```json
{
  "adapters": {
    "slack": {
      "enabled": true,
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}",
      "allowBots": "none",
      "replyBroadcast": false,
      "freeResponseChannels": ["C0123456789"],
      "freeResponseUsers": ["U0123456789"]
    },
    "wechat": {
      "enabled": false,
      "accountId": "${WECHAT_ACCOUNT_ID}",
      "token": "${WECHAT_TOKEN}",
      "dmPolicy": "allowlist",
      "allowedUsers": []
    }
  },
  "profiles": {
    "alice": {
      "userIds": ["U0123456789"],
      "scripts": "./profiles/alice/scripts",
      "workspace": "./profiles/alice/workspace",
      "data": "./profiles/alice/data"
    },
    "ops": {
      "userIds": ["U0987654321"],
      "scripts": "./profiles/ops/scripts",
      "workspace": "./profiles/ops/workspace",
      "data": "./profiles/ops/data"
    }
  },
  "scheduler": {
    "maxWorkers": 3,
    "timeoutMs": 900000
  }
}
```

## Required Vs Optional

### Required For A Minimal Slack Deployment

- `adapters.slack.enabled`
- `adapters.slack.botToken`
- `adapters.slack.appToken`
- `profiles.{name}.userIds`
- `profiles.{name}.workspace`
- `profiles.{name}.data`

`profiles.{name}.scripts` is strongly recommended because Orb appends that path to Claude Code's system prompt, but the current resolver does not hard-fail if it is missing.

### Optional

- `adapters.slack.allowBots`
- `adapters.slack.replyBroadcast`
- `adapters.slack.freeResponseChannels`
- `adapters.slack.freeResponseUsers`
- `adapters.slack.dmRouting`
- `adapters.wechat.*`
- `scheduler.maxWorkers`
- `scheduler.timeoutMs`

## Top-Level Fields

### adapters

Object keyed by adapter name.

Currently read by `src/main.js`:

- `slack`
- `wechat`

An adapter only starts when `enabled` is truthy.

### profiles

Object keyed by profile name.

Each profile should point at three directories under `profiles/{name}/`:

- `scripts`: utility scripts for the agent
- `workspace`: Claude Code working directory
- `data`: sessions, memory, DocStore index, cron jobs

### scheduler

Worker pool settings:

- `maxWorkers`: maximum foreground workers at once
- `timeoutMs`: hard timeout passed to each worker process

If omitted, the scheduler falls back to built-in defaults.

## Slack Adapter Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `enabled` | Yes | Starts the adapter when `true` |
| `botToken` | Yes | Slack bot token |
| `appToken` | Yes | Slack Socket Mode app token |
| `allowBots` | No | Bot-message policy |
| `replyBroadcast` | No | Broadcast thread replies into the parent channel |
| `freeResponseChannels` | No | Channels where the bot may answer without a mention |
| `freeResponseUsers` | No | Users who may trigger free-response behavior |
| `dmRouting` | No | Rule-based DM rerouting and worker prompt synthesis |

The historical `signingSecret` field may still appear in older examples, but the current Socket Mode startup path does not read it.

## WeChat Adapter Fields

| Field | Required When Enabled | Meaning |
| --- | --- | --- |
| `accountId` | Yes | Account identity used by the adapter |
| `token` | No | API token |
| `dmPolicy` | No | Direct-message policy |
| `allowedUsers` | No | Explicit allowlist when the policy requires it |
| `sendChunkDelayMs` | No | Delay between outbound chunks |

## Profile Routing Semantics

Orb resolves a profile by scanning `profiles.*.userIds` for the incoming platform user ID.

Important properties of the current resolver:

- There is no fallback profile for unknown users.
- The first matching `userIds` entry wins.
- A new user means a new profile entry in `config.json`; no source change is required.

That means a config like this routes two Slack users to different workspaces:

```json
{
  "profiles": {
    "alice": {
      "userIds": ["U0123456789"],
      "scripts": "./profiles/alice/scripts",
      "workspace": "./profiles/alice/workspace",
      "data": "./profiles/alice/data"
    },
    "research": {
      "userIds": ["U0987654321"],
      "scripts": "./profiles/research/scripts",
      "workspace": "./profiles/research/workspace",
      "data": "./profiles/research/data"
    }
  }
}
```

## Multi-Adapter Example

Slack plus WeChat, two profiles:

```json
{
  "adapters": {
    "slack": {
      "enabled": true,
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}"
    },
    "wechat": {
      "enabled": true,
      "accountId": "${WECHAT_ACCOUNT_ID}",
      "token": "${WECHAT_TOKEN}",
      "dmPolicy": "open",
      "allowedUsers": []
    }
  },
  "profiles": {
    "alice": {
      "userIds": ["U0123456789"],
      "scripts": "./profiles/alice/scripts",
      "workspace": "./profiles/alice/workspace",
      "data": "./profiles/alice/data"
    },
    "eting": {
      "userIds": ["o9cq804ps1h8ylV_i6h6kBT9ocUY@im.wechat"],
      "scripts": "./profiles/eting/scripts",
      "workspace": "./profiles/eting/workspace",
      "data": "./profiles/eting/data"
    }
  }
}
```

## Environment Variables

These variables are commonly relevant in a real deployment:

| Variable | Meaning |
| --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack Socket Mode app token |
| `WECHAT_ACCOUNT_ID` | WeChat account identifier |
| `WECHAT_TOKEN` | WeChat token |
| `CLAUDE_PATH` | Override the Claude Code binary path |
| `CLAUDE_MODEL` | Default Claude model for workers |
| `CLAUDE_EFFORT` | Default effort setting for workers |
| `PYTHON_PATH` | Override the Python executable used by bridges |
| `MEMORY_ENABLED` | Disable holographic memory when set to `false` |
| `DOC_INDEX_ENABLED` | Disable DocStore when set to `false` |
| `ORB_PERMISSION_APPROVAL_MODE` | `auto-allow` by default, `slack` for Slack approval cards |
| `ORB_PERMISSION_TIMEOUT_MS` | Approval timeout |
| `WORKER_IDLE_TIMEOUT_MS` | Idle lifetime for a live Claude CLI session |

## Reload Behavior

`SIGHUP` is a partial reload, not a full process rebuild.

What updates:

- `config.json` is re-read
- the cron scheduler refreshes its profile-name set

What does not update in place:

- existing adapter connections
- adapter credentials
- active workers
- already constructed scheduler limits and timeouts

If you changed tokens, adapter enablement, or worker policy, restart Orb.

## Related Files

- [getting-started.md](getting-started.md)
- [profile-guide.md](profile-guide.md)
- [architecture.md](architecture.md)
