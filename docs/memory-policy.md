# Orb Memory Policy

## Layers

| Layer | Path | Owner | Read timing | Write timing | Mutual exclusion | Archive location |
|---|---|---|---|---|---|---|
| User global | `~/.claude/CLAUDE.md` | Karry | Claude CLI auto-discovery on every session | Manual edits only | Do not duplicate project-specific runtime rules here | N/A |
| Project | `~/Orb/CLAUDE.md` | Karry | External coding sessions in repo root | Manual edits on architecture changes | Keep high-level architecture only; detailed memory policy lives in this doc | N/A |
| Agent persona | `~/Orb/profiles/{name}/workspace/CLAUDE.md` | Karry | Claude CLI auto-discovery from worker cwd | Manual edits on persona/runtime changes | Do not restate stable facts that belong in auto-memory | N/A |
| Auto-memory | `~/.claude/projects/{encoded-cwd}/memory/*.md` | Claude CLI, Orb agent, nightly cron (via prompt guidance) | Claude CLI auto-load from cwd-specific project dir | Agent writes durable facts during sessions; nightly cron may reconcile gaps | Do not mirror to `profiles/{name}/data/MEMORY.md`; use one cwd-keyed location only | Claude CLI managed |
| Skills | `~/Orb/profiles/{name}/workspace/.claude/skills/*/SKILL.md` | Orb agent | Claude CLI auto-discovery from cwd | When adding/updating profile-local skills | Do not duplicate persona or stable user facts here | Repo-local; no archive default |
| Agents | `~/.claude/agents/` and `~/Orb/profiles/{name}/workspace/.claude/agents/` | Karry / Orb agent | Claude CLI auto-discovery | When adding reusable agent definitions | Do not duplicate skills or memory facts | N/A |
| Lessons | `~/Orb/profiles/{name}/data/lessons/*.md` | Orb agent, nightly cron | Explicit retrieval via lint/grep/skills, not CLI auto-memory | When a reusable trigger/action rule is learned | Behavioral rules belong here, not in auto-memory | `~/Orb/profiles/{name}/data/lessons/_archive/` |
| Daily notes | `~/Orb/profiles/{name}/data/daily-notes/*.md` | Orb agent, nightly cron | Explicit read by reporting/review flows | Per-turn notes or nightly rebuild/hard backup | Day-specific logs do not belong in lessons or auto-memory unless promoted | `~/Orb/profiles/{name}/data/daily-notes/_archive/YYYY-MM/` |

## Path Encoding Rules

- Auto-memory cwd encoding example: `/Users/karry/Orb/profiles/karry/workspace` → `-Users-karry-Orb-profiles-karry-workspace`
- Encoding is case-sensitive.
- Single source of truth: [`src/context.js`](/Users/karry/Orb/src/context.js) `encodeCwd(cwd)`
- Cron jobs, scripts, skills, and worker prompts must not handcraft encoded cwd strings.
- `profiles/{name}/data/MEMORY.md` is an orphan path and must not be recreated.

## Write Ownership Matrix

| Layer | Karry | Orb agent | Orb wrapper | Nightly cron |
|---|---|---|---|---|
| `CLAUDE.md` | ✓ | — | — | — |
| auto-memory | — | ✓ | — | ✓ (via prompt-guided reconciliation) |
| lessons | — | ✓ | — | ✓ |
| skills | — | ✓ | — | — |

## Retention & Archival

- Lessons active set should stay at or below 50 files; overflow should be consolidated and moved to `lessons/_archive/`.
- Daily notes retain 90 days in the active folder, then move to `data/daily-notes/_archive/YYYY-MM/`.
- Auto-memory retention is managed by Claude CLI; Orb does not prune or migrate it.
- Deprecated lessons remain on disk for auditability; archival is organizational, not destructive.
