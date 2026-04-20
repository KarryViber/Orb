# Profile Guide

A profile is Orb's isolation unit. Each profile has its own Claude working directory, its own runtime data, and its own utility scripts.

## Profile Anatomy

Recommended layout:

```text
profiles/alice/
├── scripts/
├── workspace/
│   ├── CLAUDE.md
│   └── .claude/
│       ├── skills/
│       ├── agents/
│       └── settings.json
└── data/
    ├── sessions.json
    ├── memory.db
    ├── doc-index.db
    └── cron-jobs.json
```

Each directory has a separate responsibility:

- `scripts/`: executable helpers the agent may call
- `workspace/`: Claude Code `cwd` for this profile
- `data/`: Orb-owned runtime state

## What Lives In workspace/

`workspace/` is the profile's Claude Code root. Workers launch Claude Code with this directory as the current working directory, so CLI auto-discovery happens here.

Claude Code picks up:

- `workspace/CLAUDE.md`
- `workspace/.claude/skills/`
- `workspace/.claude/agents/`
- workspace-scoped CLI-managed memory

Orb adds only a small system prompt pointer to `scripts/`, plus dynamic recall and thread context.

## workspace/CLAUDE.md

This file is where profile-specific persona and execution constraints belong.

Typical contents:

- role and voice
- collaboration expectations
- operating constraints
- workflow preferences
- project-specific rules

If you want different users to feel like different agents, this is the primary file that should differ between profiles.

## workspace/.claude/skills/

Place per-profile skills here:

```text
profiles/alice/workspace/.claude/skills/my-skill/SKILL.md
```

Because the worker `cwd` is profile-specific, these skills are also profile-specific. Orb does not maintain a separate skill registry for them.

Use this directory when a profile needs domain instructions that should not leak into other users' workspaces.

## workspace/.claude/agents/

Place reusable Claude Code agents here if you want the CLI to auto-discover them for this profile.

This is optional. Many Orb profiles only need `CLAUDE.md` and a few skills.

## workspace/.claude/settings.json

Orb creates this file on demand if it does not exist.

The generated settings seed a conservative allowlist for common read-only or inspection operations:

- `Read(*)`
- `Skill(*)`
- `WebSearch`
- `WebFetch(*)`
- common shell inspection commands such as `git`, `rg`, `ls`, `find`, `cat`, `sed`, `head`, `tail`, `wc`, `pwd`, and `date`

Anything outside that allowlist can still trigger the permission flow when the worker is started with the MCP permission bridge.

## What Lives In data/

`data/` is Orb-owned runtime state:

- `sessions.json`: thread-to-Claude-session persistence
- `memory.db`: holographic fact store
- `doc-index.db`: DocStore index
- `cron-jobs.json`: scheduled jobs for this profile

Keep this directory out of git.

## Persistent Memory Model

Orb uses two persistence layers:

- Holographic memory in `data/memory.db` for fact extraction and trust-weighted recall
- Claude Code's own persistent memory for the workspace under `~/.claude/projects/<encoded-cwd>/memory/`

That split is intentional. Orb does not try to replace Claude Code's native memory system.

## How To Add A Profile

You do not need to touch `src/` to add a user.

1. Create `profiles/{name}/scripts`, `profiles/{name}/workspace`, and `profiles/{name}/data`.
2. Add or edit `profiles/{name}/workspace/CLAUDE.md`.
3. Add optional skills under `profiles/{name}/workspace/.claude/skills/`.
4. Add optional agents under `profiles/{name}/workspace/.claude/agents/`.
5. Add the profile to `config.json` with `userIds`, `scripts`, `workspace`, and `data`.

Example:

```json
{
  "profiles": {
    "alice": {
      "userIds": ["U0123456789"],
      "scripts": "./profiles/alice/scripts",
      "workspace": "./profiles/alice/workspace",
      "data": "./profiles/alice/data"
    }
  }
}
```

## What Isolation Means In Practice

Profiles are isolated at the Orb routing and filesystem-path level:

- different users map to different `workspace/` directories
- different threads persist sessions under different profile `data/`
- different profiles can expose different scripts and skills

Profiles are not hard security sandboxes. If you need OS-level separation between trust domains, run separate Orb instances or separate containers.

## Cron Per Profile

Scheduled jobs are scoped to the profile that owns the `cron-jobs.json` file. A job runs with that profile's workspace, memory, scripts path, and delivery route.

Example:

```json
{
  "id": "daily-brief",
  "name": "Daily Brief",
  "prompt": "Write today's brief.",
  "schedule": {
    "kind": "interval",
    "minutes": 30,
    "display": "every 30m"
  },
  "profileName": "alice",
  "enabled": true
}
```

## Operational Notes

- A worker is reused only within the same thread while it stays alive.
- Once the worker idles out, the next message starts a new process and resumes from persisted Claude session state when available.
- Changes to `workspace/CLAUDE.md` and workspace skills affect new worker starts, not already-running workers.
- `SIGHUP` does not rebuild active workers or reconnect adapters.

## Related Files

- [configuration.md](configuration.md)
- [adapter-development.md](adapter-development.md)
- [architecture.md](architecture.md)
