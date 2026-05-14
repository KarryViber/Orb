# Changelog

## 0.6.0 — Self-Curation + Single-Adapter Consolidation (2026-05-14)

This release narrows the platform surface and turns the self-evolution loop from a single monolithic cron into a three-stage pipeline. The big shape changes are that the multi-platform adapter abstraction collapses to a single Slack instance, the `CLAUDE.md` prompt layering grows from three layers to four with framework-wide rules moving to `profiles/CLAUDE.md`, and self-curation jobs (lesson lifecycle, skill evolution, narration audit, memory freshness, permission-blocker scan) reorganize around a shared mechanical/LLM/render split.

External agent behavior is unchanged for Slack DM and thread flows. Operators of WeChat deployments must migrate off — see Migration notes.

### Highlights

- **Single-adapter consolidation.** The `PlatformAdapter` registry collapses to a single Slack instance. WeChat adapter, the iLink CDN bridge, and capability-driven `supportsInteractiveApproval` branches are removed. The platform abstraction stays — it now describes one adapter cleanly rather than two adapters at different completeness tiers.
- **Self-evolution cron split into A/B/C.** The `Orb 自进化` cron is refactored into three stages: **A — mechanical** (deterministic data gathering, no LLM), **B — single-pass LLM** (one reasoning pass over the A bundle), **C — render** (deterministic card formatting). Each stage owns one failure mode and one model budget. Step 2.5 (daily-notes semantic compression), Step 2.7 (`关于 Karry` signal coverage audit), and Step 4b (architecture-review section) are explicit stages instead of free-form prompt sections.
- **Lesson lifecycle automation.** Lesson distill, narration-audit, candidate auto-classify (new vs. merge), and weekly seed-landing approval all share one canonical cron-narration-audit pass at 02:20 JST. Lesson similarity comparison swaps Jaccard for a Haiku-judged LLM call — short text where token cost is acceptable and Jaccard mis-clusters frequently.
- **Four-layer CLAUDE.md prompt architecture.** Prompt layering grows from three layers to four: `~/.claude/CLAUDE.md` (user-private global) / `~/Orb/CLAUDE.md` (project root) / `~/Orb/profiles/CLAUDE.md` (system-level framework rules, auto-loaded by cwd walk-up) / `profiles/{name}/workspace/CLAUDE.md` (profile-specific). Framework-level engineering practice and runtime constraints moved up from `~/.claude/CLAUDE.md` into `profiles/CLAUDE.md` so all profiles inherit them without duplication. `AGENTS.md` renamed back to `CLAUDE.md` at the project root.
- **Slack signal-to-noise rebalance.** Auto-context injection (per-turn `git diff` summary + daily-notes receipt) is now opt-in via `ORB_SLACK_AUTO_CONTEXT=1` rather than always-on. Proactive stream rotation at 4 minutes is the default (`ORB_STREAM_AUTO_ROTATE=1`). Daily-notes receipts render as small Slack context blocks; thread-history extraction whitelists the receipt block so it does not pollute future turn context. Reaction map collapsed to six canonical reactions aligned with the `reaction-action-protocol` skill.
- **Memory freshness + permission-blocker scan.** Two `holaOS` ideas land: holographic facts carry a `freshness_state` (fresh / stale / archived) updated by usage instrumentation, and a permission-blocker scan surfaces repeated approval friction as a self-evolution signal instead of dropping it on the floor.

### New

- `src/cron/orb-evolution/{stage-a,stage-b,stage-c}.js` — three-stage self-evolution pipeline.
- `src/cron/cron-narration-audit.js` — single canonical narration audit feeding lesson-lifecycle distill.
- `scripts/prompts/orb-evolution.md` — the LLM prompt for stage B, extracted from inline `cron-jobs.json`.
- `seed-landing-weekly` cron — weekly approval card sweep for accepted seeds awaiting landing.
- `silent-cron-audit` cron — flags cron jobs whose recent runs were silent without `channelSemantics: silent` declared.
- `permission-blocker-scan` cron — surfaces repeated approval friction as evolution signal.
- `worker-env: ORB_THREAD_TS / ORB_ATTEMPT_ID` — worker subprocess inherits these env vars for in-script Slack ops.
- `src/cron/cron-runtime/run-mode-script.js` (carried from 0.5) is now the foundation for cron-narration-audit and other shell-only cron jobs.

### Changed

- `task-normalizer`: when worker effort escalates (e.g. `--effort xhigh`), the model also auto-upgrades to `opus`. Previously effort and model were independent dials.
- `context.js`: goal-hint injection for multi-step user requests moved out of regex-in-context into the `execution-discipline` skill.
- `slack-stream`: fallback text changed to `"Orbiting..."` so the stream placeholder reads as the bot identity rather than a generic working indicator.
- `slack-stream`: proactive 4-minute rotate is now the default. Passive 5-minute fallback remains as a safety net.
- `auto-memory-audit`: new `--auto-archive` flag physically archives cite=0 stale candidates instead of just flagging them.
- `summary` event fields on Slack messages are routing-only metadata. Rendering paths that consumed them are removed; downstream consumers should read the explicit Block Kit blocks.
- `skill-evolution`: similarity comparison upgraded from Jaccard to LLM judge (Haiku). The Jaccard implementation is removed.
- `codex-launcher`: external Codex sessions now route IPC inject results back into the worker on completion (Unix socket), so the worker can observe `external_session_result` and decide next action instead of polling.

### Removed

- `src/adapters/wechat.js` and the WeChat iLink CDN bridge (`wechat-upload-helpers.js`, `wechat-cli-bridge.py`, related tests).
- `PlatformAdapter.supportsInteractiveApproval` capability flag and the non-interactive WeChat permission JSON renderer.
- Multi-platform registry indirection in `src/scheduler.js`; adapter list is a single Slack instance.
- Jaccard-based lesson similarity comparison.
- Inline `Orb 自进化` prompt body inside `cron-jobs.json` (moved to `scripts/prompts/orb-evolution.md`).
- `coding-agent-workflow` L1 (single-agent) guidance — folded into L2 selection rules.

### Migration notes

- **WeChat operators** must move to Slack or fork the 0.5 line. The WeChat adapter and its iLink CDN upload helpers are removed; there is no in-tree replacement.
- **Prompt layering**: if you maintained framework-level engineering rules in `~/.claude/CLAUDE.md`, the recommended home is now `~/Orb/profiles/CLAUDE.md` so every profile picks them up via cwd walk-up. `~/.claude/CLAUDE.md` remains private per user-account.
- **Slack auto-context**: per-turn `git diff` blocks and daily-notes receipts are off by default. Set `ORB_SLACK_AUTO_CONTEXT=1` in the environment to restore the 0.5 behavior.
- **`cron-jobs.json` `Orb 自进化` entry**: the inline prompt has moved to `scripts/prompts/orb-evolution.md`. Existing jobs continue to work because cron reads the prompt-file pointer through the same field; only edit the file path if you maintain a fork.

---

## 0.5.0 — Turn Delivery + Context Providers + Cron Delivery Contract (2026-05-11)

This release carries the private 0.5 work into the OSS tree with private paths removed. The big shape change is that per-turn delivery, cron delivery semantics, and context assembly now have clearer module boundaries and documented contracts.

### Highlights

- **Turn delivery refactor.** Worker per-turn delivery orchestration now lives in `src/turn-delivery/`, including orchestrator, intents, ledger, status, text stream, task-card streams, cc-event formatting/subscription, and adapter strategy. Task-card interruption recovery is separated from plan and Qi streams.
- **Cron delivery contract v2.** Adapter-owned channel rendering replaces the old shell delivery path. `deliver.mode` now supports `silent`, `direct`, `evolution_state`, and `dm_only`, with `cron-protocol` context taking precedence for delivery rules.
- **Context providers v2.** Added `cron-history`, `cron-protocol`, `channel-meta`, `legacy-attachment`, and `scratchpad` providers alongside the existing context-provider architecture.
- **Scheduler and worker decomposition.** Scheduler behavior is split across `scheduler/{task-normalizer,turn-lifecycle,worker-runner}` and worker stream parsing/tool-event state moved under `worker/`. Slack adapter behavior is similarly split into thread context, stream client, message router, and approval controller helpers.
- **AskUserQuestion MVP.** Slack Block Kit cards can carry multi-choice clarification questions, with permission relay support for the interactive path.
- **DocStore semantic upgrade.** Doc indexing is semantic-first, embedding failures are fail-loud, and wide-mode path mapping is now environment-configured instead of hardcoded.

### New

- `src/context-providers/{cron-history,cron-protocol,channel-meta,legacy-attachment,scratchpad}.js`.
- `src/turn-delivery/` as the home for per-turn delivery orchestration.
- `docs/docstore-wide-map.example.json` as a starting point for wide-mode DocStore path mappings.
- Nine clean system-scope skills under `.claude/skills/`: `adopt-from-external-repo`, `change-blast-radius-check`, `claim-vs-reality-margin`, `debug-audit-on-second-miss`, `fix-claim-acceptance-gate`, `internal-comms`, `opencli`, `theme-factory`, and `vendor-api-param-validation`.

### Changed

- Cron supports `runMode=script` for non-LLM shell execution.
- Slack stream rotation is proactive at four minutes instead of relying on passive timeout fallback.
- Slack reactions can map into quick-reply text injection.
- Worker daily-notes receipts are delivered as small Slack context blocks at the end of each turn.
- `storeConversation` fact writes moved to per-turn handling and preserve thread source metadata.
- External Codex launcher completion events can flow back into the worker through Unix socket IPC.
- SIGTERM drain now synthesizes interruption cc_events for turn delivery.
- Worker prompt-cache usage telemetry is recorded.
- Lesson-candidate handling is single-sourced.

### Removed

- `cron-deliver.sh` as the cron delivery owner; adapters now own rendering.
- Interrupted-runs auto-notify mechanism.
- Several one-off cc_event subscribers left over from the previous delivery architecture.

### Migration notes

- DocStore wide-mode users should copy `docs/docstore-wide-map.example.json`, adapt the top-level path rules, and point `DOCSTORE_WIDE_MAP_JSON` at the result. `derive_ids_wide` no longer includes organization-specific path mappings.
- Cron jobs that still call the old shell delivery path should move delivery configuration into `deliver.mode` and adapter-owned fields.
- Skills now have two layers: profile-scope `profiles/{name}/workspace/.claude/skills/` and system-scope `.claude/skills/` at the repository root, loaded into every worker via `--add-dir`.

---

## 0.4.0 — Reliability + System-Scope Skills (2026-05-02)

This release is the first hardening pass after 0.3.0's IPC refactor. It lands six batches of reliability fixes against the worker/scheduler boundary, introduces a system-scope skill layer shared across profiles, splits `src/context.js` into pluggable providers, and reshapes the on-disk layout so scripts, tests, and skills are easier to navigate.

External agent behavior is unchanged. Existing Slack flows keep working; cron jobs become more resilient under failure.

### Highlights

- **Reliability batches B1–B6.** Thirteen fixes covering cron parser hardening with corrupt-job quarantine, scheduler silent-suppress treated as terminal completion, persistence-writer failures surfaced explicitly, idempotent shutdown, profile-scoped cron keys, IPC payload validation, EventBus subscriber failure observation, empty silent-success suppression, ack/prune of interrupted runs, capability-driven `cc_event` routing, tool_use terminal-stop handling, DocStore registry caching, and timeouts for block-action handlers.
- **System-scope skills.** A second skill layer at `~/Orb/.claude/skills/` is loaded into every worker via `--add-dir`. Per-profile workspace skills still apply through CLI cwd discovery; framework-level skills (governance, language glossary, cross-profile workflow) now live once at the repo root instead of being copied into every profile. See `.claude/skills/_GOVERNANCE.md` for the layering policy.
- **Context provider abstraction.** `src/context.js` no longer concatenates external context strings inline. Each input — Holographic recall, DocStore recall, thread history, skill-review prior conversation — is a provider in `src/context-providers/` exposing `name + prefetch`, returning labeled fragments per `specs/prompt-source-labeling-DESIGN.md`. Adding a new context source means writing one provider, not editing `context.js`.
- **Repository layout refactor.** Top-level directories collapsed from 13 to 9. `scripts/` is subgrouped into `scripts/{cron,slack,wechat,infra,workflow,hooks}/`. Tests under `test/` mirror `src/` subpaths (`test/{adapters,scheduler,turn-delivery,worker}/`). Several profile-only scripts moved to repo-root `scripts/` so they are reusable across profiles.
- **Codex launcher sandbox.** External Codex sessions now use `sandbox: workspace-write` instead of `--dangerously-bypass-approvals-and-sandbox`. Workspace writes still succeed; the blast radius outside the workspace is bounded by the Codex sandbox.

### New

- `src/context-providers/` — `docstore.js`, `holographic.js`, `thread-history.js`, `skill-review.js`, `interface.js`. Providers return `LabeledFragment[]` carrying source/trust/origin metadata.
- `src/scheduler-skill-review.js`, `src/skill-review-trigger.js` — skill-review dispatch hook for the periodic skill-curation cron.
- `src/scheduler-shutdown-persistence.js` — explicit shutdown-state snapshot so cron jobs can replay correctly after restart.
- `src/scheduler-memory-maintenance.js` — scheduler-side memory hygiene.
- `src/worker-git-diff.js`, `src/worker-image-blocks.js`, `src/worker-mcp-boot.js`, `src/worker-turn-text.js` — worker decomposition into single-purpose modules.
- `src/turn-delivery/` — eight files implementing per-turn delivery orchestration (intents, ledger, status, text-stream, task-card-streams, cc-event-format, cc-event-subscriber, adapter-strategy, orchestrator).
- `src/adapters/slack-permission-render.js`, `src/adapters/slack-stream-error.js`, `src/adapters/slack-block-actions.js`, `src/adapters/slack-dm-routing.js`, `src/adapters/image-cache.js` — Slack adapter split into focused helpers.
- `src/ipc-schema.js` — single source of truth for worker↔scheduler IPC payload shapes; runtime-validated.
- `src/runtime-env.js` — centralized env loading and validation.
- `src/stop-reason.js` — unified `stopReason` classification (`success`, `truncated`, `api_error`, `cli_error`, etc.) shared by worker and scheduler.
- `src/lesson-candidates.js` — lesson candidate detection / persistence.
- `src/dm-routing-schema.js` — DM inbound routing schema validation.
- `src/spawn.js` — Claude CLI subprocess spawn helper.

### Changed

- `cron-deliver.sh` and `slack-blockkit.py` / `slack-send-attachment.py` accept `--channel-name` and resolve via `config.channels`. Cron prompts no longer hardcode channel IDs.
- `slack-format` enforces `mrkdwn-normalize` on explicit Block Kit blocks so `## ` markdown leaks no longer reach Slack.
- `worker.js` reduced again as turn delivery moved to `src/turn-delivery/`.
- Worker IPC `task` and `inject` payloads carry an `attemptId` threaded through every downstream message for delivery-ledger correlation, plus `origin: { kind, name, parentAttemptId }` for replay/debug attribution.
- `cron-jobs.json` cron entries support an optional `maxTurns` field to override Claude CLI `--max-turns` per job.
- `@slack/socket-mode` 2.0.6 → 2.0.7.

### Fixed

- `turn-delivery`: initial TodoWrite plan chunks were dropped when the plan stream started before the worker emitted a snapshot — now appended explicitly.
- `turn-delivery`: TodoWrite plan stream and Qi task-card stream are split; finalize on one no longer races the other.
- `cron`: `cron_run_log` import path and lesson-rewrite backup location.
- `cron`: parser defends against malformed `cron-jobs.json` entries; corrupt jobs are quarantined instead of crashing the scheduler.
- `claudemd-lint`: cleared 6 architecture warnings (doc drift + lint false positives).
- `extract` / `evolution`: rescued fact-extraction pipeline; restored evolution-anchor Slack post.
- `skill-manager-mcp`: Slack delivery is now fail-loud; path resolution corrected.
- `cron-deliver`: pre-validates thread/blocks files before sending the main message so partial failures are caught earlier.

### Removed

- Four legacy `cc_event` subscribers and their feature flag (Spec D-3).

### Migration notes

If you maintain a fork:

- `src/context.js` no longer accepts string concatenation patches. Add a provider under `src/context-providers/` implementing `{ name, prefetch }` and returning `LabeledFragment[]`.
- The `attemptId` and `origin` fields on `task`/`inject` IPC are mandatory in flight; the scheduler generates `attemptId` if absent so existing call sites still work, but new code should propagate them.
- Skills you placed in `profiles/{name}/workspace/.claude/skills/` continue to work. Framework-level skills you want to share across profiles can move to `~/Orb/.claude/skills/`; the CLI sees both layers via `--add-dir`.

---

## 0.3.0 — Event Stream Unification (2026-04-25)

This release refactors Orb's internal IPC protocol from 28 message types into a single `cc_event` stream and moves all platform-specific UI rendering into adapters. The result is a cleaner extension surface, structured per-turn audit logs, and the first proper multi-platform hardening pass.

External agent behavior is unchanged. Users who only consume Orb through Slack will see no difference.

### Highlights

- **Worker is now a thin event forwarder.** `worker.js` decoded ~500 lines of "Claude CLI events → platform-specific UI primitives" before; that translation now lives entirely in `src/adapters/slack.js` as four `cc_event` subscribers (Qi card, TodoWrite plan card, intermediate text, thread status).
- **Single IPC contract.** Worker→Scheduler messages reduced from 28 types to 6: `turn_start`, `turn_end`, `turn_complete`, `cc_event`, `inject_failed`, `error`. Adding a new platform renderer or audit consumer now means writing one subscriber, not extending the IPC enum.
- **Per-turn audit log.** Every Claude Code event (text, tool_use, tool_result, result) is appended to `profiles/{name}/data/cc-events/{YYYY-MM-DD}.jsonl` with `turn_id` and optional `job_id` (for cron). Use `jq` to answer questions like "which cron jobs called WebFetch last night" directly from disk.
- **Cross-platform hardening.** WeChat is now a fully exercised adapter alongside Slack: capability checks replace `platform === 'slack'` hardcoding in the scheduler, and the typing/status path is capability-driven.

### New architecture

- `EventBus` in `src/scheduler.js` (subscribe / publish). Subscribers register at adapter `start` time.
- `createCcSubscriber` factory in `src/adapters/slack.js` provides per-turn state, start-promise mutex, and serialized append for streaming task cards. Qi and Plan subscribers are thin wrappers over it.
- `PlatformAdapter` interface in `src/adapters/interface.js` declares an explicit `supportsInteractiveApproval` capability.

### Behavior changes

- Slack `task_update.details` is no longer double-fed at finalize. The "Distilled from N probes" line previously rendered as "Distilled from N probesDistilled from N probes" because both `appendStream` and `stopStream` were sent the settled chunks; finalize now only calls `stopStream({ chunks })`.
- WeChat permission requests no longer auto-approve under `ORB_PERMISSION_APPROVAL_MODE=slack`. Adapters that lack interactive approval must opt in via `supportsInteractiveApproval = true`. WeChat now formats permission prompt fields as JSON instead of `[object Object]`.
- WeChat typing/status indicator now works on the first turn after worker spawn. The previous race (typing ticket prefetch was fire-and-forget; first `setTyping(true)` would silently miss on cache miss) is fixed by an in-flight prefetch promise plus 500ms timeout.
- Scheduler's `editMessage` call now falls back to `sendReply` when the adapter does not implement editing.
- Abandoning a turn (e.g. on inject) now explicitly clears thread status so the WeChat indicator does not linger to TTL.

### Removed

- `src/scheduler.js`: handlers for `progress_update`, `plan_title_update`, `plan_snapshot`, `tool_call`, `tool_result`, `status_update`, `intermediate_text`, `qi_start`, `qi_append`, `qi_finalize` (worker no longer emits any of these). Roughly 1200 lines of dead state and helper code went with them.
- Slack-specific UI assumptions in `scheduler.js` (`progressTs`, `planTitle`, `taskCards`, `pendingPlanSection`, `planSectionPromise`, `lastSentPlanTitle`, `armKeepalive`, `chainTaskCardAppend`, `appendTaskCardPlan`, `appendTaskCardSnapshot`, `closeQiStreamState`, `ensureTaskCardStreamStarted`).

### Internal stats

| File | Before | After | Δ |
|------|--------|-------|---|
| `src/worker.js` | 1152 | 980 | −15% |
| `src/scheduler.js` | 2535 | 1575 | −38% |
| `src/adapters/slack.js` | 2032 | 2426 | +19% (absorbed translation layer) |

50 tests, all passing.

### Migration notes

If you fork the worker/scheduler IPC contract, the five new IPC types are documented in `src/worker.js` (top of file). The cc_event payload mirrors Claude Code's stream-json blocks and is the recommended extension point.

If you build a new platform adapter:

1. Implement the methods in `src/adapters/interface.js`. Stream methods (`startStream`/`appendStream`/`stopStream`) are optional and only needed if the platform supports streaming task cards.
2. Optionally export `createQiSubscriber()` / `createPlanSubscriber()` / `createTextSubscriber()` / `createStatusSubscriber()` from your adapter; the scheduler will register them on `addAdapter`.
3. Set `supportsInteractiveApproval` according to whether your platform has a real approval UI.

See `docs/adapter-development.md` for full details.

### Tests added

- `test/qi-subscriber.test.js`, `test/plan-subscriber.test.js`, `test/text-subscriber.test.js`, `test/status-subscriber.test.js`
- `test/scheduler-ipc-statemachine.test.js`, `test/task-card-plan-batch.test.js` (rewritten)
- `test/wechat-typing-fetch-on-miss.test.js`, `test/wechat-permission-non-interactive.test.js`, `test/wechat-hooks-non-slack-thread-id.test.js`
- `test/slack-subscriber-platform-isolation.test.js`, `test/scheduler-editmessage-capability-fallback.test.js`
- `test/scheduler-inject-platform-preserve.test.js`, `test/scheduler-abandon-typing-clear.test.js`
- `test/cron-cc-event-jsonl-only.test.js`

---

## 0.2.0 — 2026-04-23

Initial open-source release.
