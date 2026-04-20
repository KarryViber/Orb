# Profile Guide

Each profile is an isolated Claude Code workspace. Multiple profiles can run on the same Orb instance, each responding to different users with its own workspace, scripts, runtime state, and Claude Code auto-memory.

## Directory Structure

```
profiles/your-name/
├── scripts/             # Utility scripts the agent can execute
├── workspace/           # Claude Code working directory for this profile
│   ├── CLAUDE.md        # Persona + runtime constraints
│   └── .claude/
│       ├── skills/
│       │   └── my-skill/SKILL.md
│       └── agents/      # Optional per-profile agents
└── data/                # Auto-generated at runtime (gitignored)
    ├── sessions.json    # Thread ↔ session mappings
    ├── memory.db        # Holographic memory database
    ├── doc-index.db     # DocStore index (when enabled)
    └── cron-jobs.json   # Scheduled tasks
```

## workspace/CLAUDE.md — Persona And Runtime Constraints

This is the profile's main instruction file. Put persona, collaboration style, execution discipline, and workspace-specific rules here.

```markdown
# Persona

You are [name], [brief description].

# Collaboration Boundaries

- [rule 1]
- [rule 2]
```

Claude Code discovers three `CLAUDE.md` layers automatically:

- `~/.claude/CLAUDE.md`
- `~/Orb/CLAUDE.md`
- `profiles/{name}/workspace/CLAUDE.md`

Orb does not manually rebuild those layers on `SIGHUP`. Changes in `workspace/CLAUDE.md`, `workspace/.claude/skills/`, `workspace/.claude/agents/`, or CLI auto-memory are picked up by new worker/session starts; active workers keep the context they already started with.

## Claude Code Auto-Memory

Persistent memory is managed by Claude Code CLI under:

```text
~/.claude/projects/<encoded-cwd>/memory/
```

Orb no longer uses `profiles/{name}/data/MEMORY.md`. Treat the CLI-managed auto-memory as the durable store tied to the profile workspace `cwd`.

## workspace/.claude/skills/ — Agent Skills

Place Claude Code skills under `workspace/.claude/skills/<skill-name>/SKILL.md`. Claude Code auto-discovers them from the workspace `cwd`; Orb does not inject a separate skill index file.

Skill files must include `name:` and `description:` fields:

```markdown
---
name: my-skill
description: Does something useful
---

# Steps

1. ...
```

The agent can then invoke the skill by reading the full file when needed.

## workspace/.claude/agents/ — Optional Agents

Place reusable per-profile agents under `workspace/.claude/agents/` if you want Claude Code to auto-discover them from the profile workspace.

## scripts/ — Utility Scripts

Place executable scripts here for the agent to run during tasks. Can be any language. Orb appends the scripts directory path as a small system-prompt hint so the agent knows where to look.

## data/ — Runtime Data (auto-generated)

Never commit `data/` — it's gitignored. Contains:

- `sessions.json` — maps `{platform}:{threadTs}` → Claude session ID, enabling conversation resumption
- `memory.db` — holographic memory: conversation embeddings, extracted facts, preference signals
- `doc-index.db` — DocStore full-text index (when enabled)
- `cron-jobs.json` — scheduled task definitions (read/write directly to manage cron jobs)

## Retired Files

- `profiles/{name}/soul/SOUL.md` and `profiles/{name}/soul/USER.md` are retired. Persona and user-facing operating style now belong in `workspace/CLAUDE.md`.
- `profiles/{name}/data/MEMORY.md` is retired. Persistent Claude-side memory now lives in `~/.claude/projects/<encoded-cwd>/memory/`.

Legacy profiles may still contain those files, but the current prompt architecture does not depend on them.

## Creating a New Profile

```bash
cp -r profiles/example profiles/your-name
```

Then:
1. Edit `profiles/your-name/workspace/CLAUDE.md` — define the persona and runtime constraints
2. Add optional skills under `profiles/your-name/workspace/.claude/skills/`
3. Add optional agents under `profiles/your-name/workspace/.claude/agents/`
4. Add your Slack user ID to `config.json` under the new profile name

## Cron Jobs

The agent can manage its own scheduled tasks by reading/writing `data/cron-jobs.json`. See `CLAUDE.md` root for the job schema.

Schedules support:
- Cron expression: `"0 9 * * *"` (daily at 9am)
- Interval: `"every 30m"`
- One-shot delay: `"2h"` or ISO timestamp

## Reloading Configuration

`SIGHUP` is a partial reload only:

- Re-reads `config.json`
- Refreshes the cron scheduler's profile-name set

It does not rebuild adapters, rotate adapter tokens, reconnect an existing Slack Socket Mode session, restart active workers, or apply scheduler limits/timeouts already loaded in memory. Restart the daemon if you need those changes to take effect.
