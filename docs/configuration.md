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
- `scheduler.maxWorkers`
- `scheduler.timeoutMs`

## Top-Level Fields

### adapters

Object keyed by adapter name.

Currently read by `src/main.js`:

- `slack`

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

The authoritative list is `src/runtime-env.js` (loaded at startup). Below mirrors that file plus a few bridge-only / hook-only knobs.

### Adapter credentials

| Variable | Meaning |
| --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack Socket Mode app token |
| `WECHAT_ACCOUNT_ID` | WeChat account identifier |
| `WECHAT_TOKEN` | WeChat token |

### Claude CLI / runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_PATH` | `claude` | Override the Claude Code binary path |
| `CLAUDE_MODEL` | unset | Default Claude model for workers |
| `CLAUDE_EFFORT` | unset | Default effort setting for workers |
| `PYTHON_PATH` | `python3` | Override the Python executable used by bridges |
| `MAX_TURNS` | `50` | Default Claude CLI `--max-turns` cap (per-task `maxTurns` overrides) |
| `WORKER_IDLE_TIMEOUT_MS` | `60000` | Idle lifetime for a live Claude CLI session before the worker exits |
| `ORB_WORKER_TIMEOUT_MS` | `1800000` | Hard worker process timeout (30 min default; raise for long skill writes / refactors) |

### Permission / approval

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORB_PERMISSION_APPROVAL_MODE` | `auto-allow` | `auto-allow` by default, `slack` for Slack approval cards |
| `ORB_PERMISSION_TIMEOUT_MS` | `300000` | Approval timeout |
| `ORB_MCP_PERMISSION_LOG` | unset | Optional log path for MCP permission server events |

### Memory / DocStore

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_ENABLED` | `true` | Disable holographic memory when set to `false` |
| `DOC_INDEX_ENABLED` | `true` | Disable DocStore when set to `false` |
| `DOC_INDEX_DB` | unset | Override DocStore SQLite path |
| `DOC_REGISTRY_PATH` | unset | Override DocStore registry path |
| `DOC_PROJECTS_ROOT` | unset | Override DocStore project root |
| `ORB_MEMORY_RECALL_LIMIT` | `10` | Holographic recall fact count cap |
| `ORB_MEMORY_MIN_TRUST` | `0.3` | Minimum trust score for holographic recall |
| `ORB_DOC_RECALL_LIMIT` | `8` | DocStore recall snippet cap |

### Prompt / delivery instrumentation

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORB_PROMPT_TOKEN_BUDGET` | unset | Optional token budget hint for prompt assembly |
| `ORB_PROMPT_SOURCE_LABELING` | `true` | Prompt source labeling flag (compatibility readback) |
| `ORB_LEDGER_HYDRATE` | `true` | Hydrate delivery ledger at startup |
| `ORB_STREAM_TRACE` | `false` | Verbose stream client tracing |
| `ORB_EVENTBUS_SMOKE_LOG` | `false` | Event bus smoke-test logging |

### Paths / workspace

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMAGE_CACHE_DIR` | `~/.orb/cache/images` | Adapter-shared image download cache |
| `WORKSPACE_DIR` | unset | Override per-profile workspace directory resolution |

### Git hooks (commit-time only)

| Variable | Meaning |
| --- | --- |
| `ORB_BOUNDARY_OVERRIDE` | Set to `1` to bypass `scripts/git-hooks/pre-commit` repo-boundary lineage enforcement on `src/**`, `.claude/skills/**`, `package.json`, `config.json`, `start.sh`. Stderr leaves a trace. Use only for emergency overrides |

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
