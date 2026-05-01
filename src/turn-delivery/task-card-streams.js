import { warn } from '../log.js';
import {
  TASK_PROGRESS_APPEND,
  TASK_PROGRESS_START,
  TASK_PROGRESS_STOP,
} from './intents.js';
import {
  buildPlanSnapshotChunks,
  buildQiSettledChunks,
  buildQiToolChunks,
  categorizeTool,
  chunksText,
  qiInitialChunks,
} from './cc-event-format.js';

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
  };
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
      if (msg.eventType === 'tool_use') {
        if (!matchTool(msg, ctx, state)) return;
        const chunks = buildToolChunks(msg, ctx, state);
        if (!Array.isArray(chunks) || chunks.length === 0) return;
        const hadStream = Boolean(state.streamId);
        const initialChunks = getInitialChunks(msg, ctx, state, chunks);
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
      const chunks = onResult(msg, ctx, state);
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
          meta: { streamChannel, streamId, chunks, chunkCount: Array.isArray(chunks) ? chunks.length : 0 },
        });
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
