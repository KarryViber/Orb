# Profile Guide

Each profile is a self-contained agent identity. Multiple profiles can run simultaneously on the same Orb instance, each responding to different users.

## Directory Structure

```
profiles/your-name/
├── soul/
│   ├── SOUL.md          # Agent persona & collaboration boundaries
│   └── USER.md          # User profile (auto-synced from holographic memory)
├── skills/              # Claude Code agent-format skill files (.md)
├── scripts/             # Utility scripts the agent can execute
├── workspace/
│   └── CLAUDE.md        # Agent runtime constraints (read by Claude CLI)
└── data/                # Auto-generated at runtime (gitignored)
    ├── sessions.json    # Thread ↔ session mappings
    ├── memory.db        # Holographic memory database
    ├── cron-jobs.json   # Scheduled tasks
    └── MEMORY.md        # Distilled facts (injected into system prompt)
```

## SOUL.md — Agent Persona

Defines who the agent is and how it behaves. This is the core identity file.

```markdown
# Identity

You are [name], [brief description].

# Collaboration Boundaries

- [rule 1]
- [rule 2]
```

Loaded once per session (cached, invalidated on SIGHUP). Changes take effect on next cold start or SIGHUP.

## USER.md — User Profile

Describes the user the agent is assisting. Used to tailor responses.

```markdown
# User Profile

- **Name**: Alice
- **Timezone**: America/New_York
- **Language**: English
- **Work style**: Direct, prefers bullet points over prose
```

This file is automatically updated by the scheduler when holographic memory extracts high-trust preference facts. You can also edit it manually.

## workspace/CLAUDE.md — Runtime Constraints

Read by Claude Code CLI as its `CLAUDE.md` file (from the workspace `cwd`). Controls agent behavior at the execution level — what it's allowed to do, output format, discipline rules.

The example in `profiles/example/workspace/CLAUDE.md` is a good starting point.

## skills/ — Agent Skills

Place Claude Code agent-format skill files here. Each `.md` file is auto-indexed and injected into the system prompt as a skill reference.

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

## scripts/ — Utility Scripts

Place executable scripts here for the agent to run during tasks. Can be any language. The scripts directory path is injected into the system prompt so the agent knows where to look.

## data/ — Runtime Data (auto-generated)

Never commit `data/` — it's gitignored. Contains:

- `sessions.json` — maps `{platform}:{threadTs}` → Claude session ID, enabling conversation resumption
- `memory.db` — holographic memory: conversation embeddings, extracted facts, preference signals
- `cron-jobs.json` — scheduled task definitions (read/write directly to manage cron jobs)
- `MEMORY.md` — distilled high-trust facts, injected into every system prompt

## Creating a New Profile

```bash
cp -r profiles/example profiles/your-name
```

Then:
1. Edit `profiles/your-name/soul/SOUL.md` — define the persona
2. Edit `profiles/your-name/soul/USER.md` — describe the user
3. Edit `profiles/your-name/workspace/CLAUDE.md` — customize runtime constraints
4. Add your Slack user ID to `config.json` under the new profile name

## Cron Jobs

The agent can manage its own scheduled tasks by reading/writing `data/cron-jobs.json`. See `CLAUDE.md` root for the job schema.

Schedules support:
- Cron expression: `"0 9 * * *"` (daily at 9am)
- Interval: `"every 30m"`
- One-shot delay: `"2h"` or ISO timestamp
