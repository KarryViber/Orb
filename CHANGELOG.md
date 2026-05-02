# Changelog

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
