import { warn } from '../log.js';
import { isInterruptedStopReason } from '../stop-reason.js';
import {
  CONTROL_PLANE_MESSAGE,
  TASK_PROGRESS_APPEND,
  TASK_PROGRESS_START,
  TASK_PROGRESS_STOP,
} from './intents.js';
import {
  buildPlanInterruptedChunks,
  buildPlanSnapshotChunks,
  buildQiInterruptedChunks,
  buildQiSettledChunks,
  buildQiToolChunks,
  categorizeTool,
  chunksText,
  qiInitialChunks,
} from './cc-event-format.js';
import { buildInterruptedPlanSnapshotText } from './task-card-format.js';

const TAG = 'turn-delivery-cc-event';

function getTurnKey(turnId) {
  return turnId || 'default';
}

function makeQiTurnState() {
  return {
    streamId: null,
    streamTs: null,
    startPromise: null,
    appendPromise: null,
    failed: false,
    toolCount: 0,
    appendSeq: 0,
    lastPlanChunk: null,
    taskChunks: new Map(),
    summarySnapshot: null,
  };
}

function makePlanTurnState() {
  return {
    streamId: null,
    streamTs: null,
    startPromise: null,
    appendPromise: null,
    failed: false,
    lastChunks: [],
    appendSeq: 0,
    lastPlanChunk: null,
    taskChunks: new Map(),
    summarySnapshot: null,
  };
}

function extractStopReason(msg) {
  return String(msg?.stopReason || msg?.payload?.stopReason || msg?.payload?.stop_reason || '').trim();
}

function extractExitCode(msg) {
  const value = msg?.exitCode ?? msg?.payload?.exitCode ?? msg?.payload?.exit_code ?? null;
  return Number.isInteger(value) ? value : null;
}

function extractSummarySnapshot(msg) {
  const payload = msg?.payload && typeof msg.payload === 'object' ? msg.payload : {};
  return {
    gitDiffSummary: payload.gitDiffSummary || null,
    dailyNotesSummary: payload.dailyNotesSummary || null,
  };
}

function hasSummaryBlocks(snapshot) {
  return Boolean(snapshot?.gitDiffSummary?.hasChanges || snapshot?.dailyNotesSummary?.count);
}

function isInterruptedResult(msg) {
  if (msg?.eventType !== 'result') return false;
  return isInterruptedStopReason(extractStopReason(msg), { exitCode: extractExitCode(msg) });
}

function rowsFromChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .filter((chunk) => chunk?.type === 'task_update' && String(chunk.id || '').startsWith('todowrite-todo-'))
    .map((chunk) => ({
      task_id: String(chunk.id || ''),
      title: String(chunk.title || ''),
      status: chunk.status === 'complete' || chunk.status === 'in_progress' || chunk.status === 'error'
        ? chunk.status
        : 'pending',
    }))
    .filter((row) => row.task_id && row.title);
}

function rememberChunks(state, chunks) {
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'plan_update') {
      state.lastPlanChunk = { ...chunk };
      continue;
    }
    if (chunk.type !== 'task_update') continue;
    const id = String(chunk.id || '').trim();
    if (!id) continue;
    const previous = state.taskChunks?.get(id) || {};
    const next = { ...previous, ...chunk };
    if (typeof previous.details === 'string' && typeof chunk.details === 'string' && previous.details && chunk.details) {
      next.details = `${previous.details}${chunk.details}`;
    }
    if (!state.taskChunks) state.taskChunks = new Map();
    state.taskChunks.set(id, next);
  }
}

function rebuildRememberedChunks(state, fallbackChunks = []) {
  const chunks = [];
  if (state.lastPlanChunk) chunks.push({ ...state.lastPlanChunk });
  if (state.taskChunks?.size > 0) {
    chunks.push(...[...state.taskChunks.values()].map((chunk) => ({ ...chunk })));
  }
  return chunks.length > 0 ? chunks : fallbackChunks.map((chunk) => ({ ...chunk }));
}

function latestPlanRowsFromLedger(ctx, turnId) {
  const records = ctx?.orchestrator?.ledger?.getRecordsForTurn?.(turnId) || [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.meta?.streamChannel !== 'plan') continue;
    const rows = rowsFromChunks(record?.meta?.chunks);
    if (rows.length > 0) return rows;
  }
  return [];
}

async function emitInterruptedPlanSnapshot(msg, ctx, state) {
  if (state.snapshotPosted) return;
  state.snapshotPosted = true;
  const ledgerRows = latestPlanRowsFromLedger(ctx, msg.turnId);
  const rows = ledgerRows.length > 0 ? ledgerRows : rowsFromChunks(state.lastChunks);
  const stopReason = extractStopReason(msg) || 'unknown';
  const text = buildInterruptedPlanSnapshotText({
    attemptId: ctx?.task?.attemptId || msg.turnId || '',
    stopReason,
    rows,
  });
  await ctx.orchestrator?.emit({
    turnId: msg.turnId,
    attemptId: ctx?.task?.attemptId || '',
    channel: ctx?.channel || ctx?.task?.channel || '',
    threadTs: ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs || '',
    platform: ctx?.platform || ctx?.adapter?.platform || 'slack',
    channelSemantics: ctx?.channelSemantics,
    intent: CONTROL_PLANE_MESSAGE,
    text,
    source: 'subscriber.plan.interrupt_snapshot',
    meta: { stopReason, sticky: true },
  });
}

export function createTaskCardStreamProcessor({
  streamChannel,
  matchTool,
  makeState,
  buildToolChunks,
  getInitialChunks,
  onResult,
  recordSource = 'subscriber.qi',
} = {}) {
  if (!streamChannel) throw new Error('streamChannel is required');
  const turns = new Map();
  const getState = (turnId) => {
    const key = getTurnKey(turnId);
    if (!turns.has(key)) turns.set(key, makeState());
    return turns.get(key);
  };

  const ensureStarted = async (state, ctx, initialChunks, turnId = null) => {
    if (state.streamId || state.failed) return Boolean(state.streamId);
    if (state.startPromise) {
      await state.startPromise;
      return Boolean(state.streamId);
    }
    const taskCardState = ctx?.turn?.taskCardStates?.[streamChannel];
    if (taskCardState?.streamId) return false;
    const channel = ctx?.channel || ctx?.task?.channel;
    const threadTs = ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs;
    if (!channel || !threadTs) return false;
    state.startPromise = (async () => {
      try {
        const result = await ctx.orchestrator?.emit({
          turnId,
          attemptId: ctx?.task?.attemptId || '',
          channel,
          threadTs,
          platform: ctx?.platform || ctx?.adapter?.platform || 'slack',
          channelSemantics: ctx?.channelSemantics,
          intent: TASK_PROGRESS_START,
          source: recordSource,
          text: chunksText(initialChunks),
          meta: {
            task_display_mode: 'plan',
            streamChannel,
            chunks: initialChunks,
            teamId: ctx?.task?.teamId || ctx?.teamId || null,
            rebuildInitialChunks: () => rebuildRememberedChunks(state, initialChunks),
            onRotate: ({ stream_id: newStreamId, ts }) => {
              state.streamId = newStreamId;
              state.streamTs = ts || null;
              if (ctx?.turn?.taskCardStates?.[streamChannel]) {
                ctx.turn.taskCardStates[streamChannel].streamId = newStreamId;
                ctx.turn.taskCardStates[streamChannel].streamMessageTs = ts || null;
              }
            },
          },
        });
        const turnState = ctx?.orchestrator?.getTurnState?.(turnId);
        state.streamId = ctx?.turn?.taskCardStates?.[streamChannel]?.streamId
          || turnState?.streamIds?.[streamChannel]
          || null;
        state.streamTs = result?.ts
          || ctx?.turn?.taskCardStates?.[streamChannel]?.streamMessageTs
          || turnState?.streamMessageTsByChannel?.[streamChannel]
          || null;
      } catch (err) {
        state.failed = true;
        if (taskCardState) taskCardState.failed = true;
        warn(TAG, `[task_card] start failed: ${err.message}`);
      } finally {
        state.startPromise = null;
      }
    })();
    await state.startPromise;
    return Boolean(state.streamId);
  };

  const chainAppend = (state, operation) => {
    const previous = state.appendPromise || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    state.appendPromise = next.finally(() => {
      if (state.appendPromise === next) state.appendPromise = null;
    });
    return state.appendPromise;
  };

  const clear = (turnId) => {
    turns.delete(getTurnKey(turnId));
  };

  return {
    async handle(msg, ctx = {}) {
      const key = getTurnKey(msg.turnId);
      if (ctx?.channelSemantics === 'silent' || ctx?.deferDeliveryUntilResult) {
        turns.delete(key);
        return;
      }
      const state = getState(msg.turnId);
      if (msg.eventType === 'summary_snapshot') {
        const snapshot = extractSummarySnapshot(msg);
        state.summarySnapshot = hasSummaryBlocks(snapshot) ? snapshot : null;
        return;
      }
      if (msg.eventType === 'tool_use') {
        if (!matchTool(msg, ctx, state)) return;
        const chunks = buildToolChunks(msg, ctx, state);
        if (!Array.isArray(chunks) || chunks.length === 0) return;
        const hadStream = Boolean(state.streamId);
        const initialChunks = getInitialChunks(msg, ctx, state, chunks);
        rememberChunks(state, initialChunks);
        rememberChunks(state, chunks);
        if (!await ensureStarted(state, ctx, initialChunks, msg.turnId)) return;
        if (state.failed || !state.streamId) return;
        const appendSequence = state.appendSeq = (state.appendSeq || 0) + 1;
        await chainAppend(state, async () => {
          if (!state.streamId) return;
          await ctx.orchestrator?.emit({
            turnId: msg.turnId,
            attemptId: ctx?.task?.attemptId || '',
            channel: ctx?.channel || ctx?.task?.channel || '',
            threadTs: ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs || '',
            platform: ctx?.platform || ctx?.adapter?.platform || 'slack',
            channelSemantics: ctx?.channelSemantics,
            intent: TASK_PROGRESS_APPEND,
            text: chunksText(chunks),
            source: recordSource,
            meta: { sequence: appendSequence, streamChannel, streamId: state.streamId, chunks, chunkCount: chunks.length },
          });
        }).catch((err) => {
          warn(TAG, `[task_card] append failed: ${err.message}`);
        });
        return;
      }

      if (msg.eventType !== 'result' && msg.eventType !== 'turn_abort') return;
      if (state.startPromise) await state.startPromise;
      if (state.appendPromise) await state.appendPromise.catch(() => {});
      if (!state.streamId || msg.eventType === 'turn_abort') {
        turns.delete(key);
        return;
      }
      const streamId = state.streamId;
      // onResult must emit stop so the card can settle, even if
      // ASSISTANT_TEXT_FINAL already cleared turnState. The stale check inside
      // chainAppend remains to avoid message_not_in_streaming_state.
      const interrupted = isInterruptedResult(msg);
      const chunks = interrupted && streamChannel === 'plan'
        ? buildPlanInterruptedChunks(extractStopReason(msg))
        : interrupted && streamChannel === 'qi'
          ? buildQiInterruptedChunks(state.toolCount, extractStopReason(msg))
          : onResult(msg, ctx, state);
      rememberChunks(state, chunks);
      try {
        await ctx.orchestrator?.emit({
          turnId: msg.turnId,
          attemptId: ctx?.task?.attemptId || '',
          channel: ctx?.channel || ctx?.task?.channel || '',
          threadTs: ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs || '',
          platform: ctx?.platform || ctx?.adapter?.platform || 'slack',
          channelSemantics: ctx?.channelSemantics,
          intent: TASK_PROGRESS_STOP,
          text: chunksText(chunks),
          source: recordSource,
          meta: {
            streamChannel,
            streamId,
            chunks,
            chunkCount: Array.isArray(chunks) ? chunks.length : 0,
            ...(streamChannel === 'qi' && hasSummaryBlocks(state.summarySnapshot) ? state.summarySnapshot : {}),
          },
        });
        if (interrupted && streamChannel === 'plan') {
          await emitInterruptedPlanSnapshot(msg, ctx, state);
        }
      } catch (err) {
        warn(TAG, `[task_card] stop failed: ${err.message}`);
      } finally {
        if (ctx?.turn?.taskCardStates?.[streamChannel]?.streamId === streamId) {
          ctx.turn.taskCardStates[streamChannel].streamId = null;
        }
        turns.delete(key);
      }
    },
    clear,
  };
}

export function createQiStreamProcessor() {
  return createTaskCardStreamProcessor({
    streamChannel: 'qi',
    recordSource: 'subscriber.qi',
    makeState: makeQiTurnState,
    matchTool(msg, ctx) {
      const category = categorizeTool(msg.payload?.name);
      if (!category) return false;
      const taskCardState = ctx?.turn?.taskCardStates?.qi;
      if (taskCardState && !taskCardState.enabled && !taskCardState.deferred) return false;
      return !taskCardState?.failed;
    },
    buildToolChunks: (msg, ctx, state) => buildQiToolChunks(msg.payload, state),
    getInitialChunks: () => qiInitialChunks(),
    onResult: (msg, ctx, state) => buildQiSettledChunks(state.toolCount),
  });
}

export function createPlanStreamProcessor() {
  return createTaskCardStreamProcessor({
    streamChannel: 'plan',
    recordSource: 'subscriber.plan',
    makeState: makePlanTurnState,
    matchTool: (msg, ctx) => {
      if (msg.payload?.name !== 'TodoWrite' || !Array.isArray(msg.payload?.input?.todos)) return false;
      const taskCardState = ctx?.turn?.taskCardStates?.plan;
      if (taskCardState && !taskCardState.enabled && !taskCardState.deferred) return false;
      return !taskCardState?.failed;
    },
    buildToolChunks(msg, ctx, state) {
      const chunks = buildPlanSnapshotChunks(msg.payload.input.todos);
      state.lastChunks = chunks;
      return chunks;
    },
    getInitialChunks: (msg, ctx, state, chunks) => chunks,
    onResult: (msg, ctx, state) => state.lastChunks,
  });
}
