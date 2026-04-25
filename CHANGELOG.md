# Changelog

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
