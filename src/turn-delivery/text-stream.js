import { warn } from '../log.js';
import { ASSISTANT_TEXT_DELTA } from './intents.js';

const TAG = 'turn-delivery-cc-event';
const DEFAULT_TEXT_DEBOUNCE_MS = 2000;

function getTurnKey(turnId) {
  return turnId || 'default';
}

function isStreamOwnershipError(err) {
  const code = err?.data?.error || err?.code || '';
  return code === 'message_not_in_streaming_state' || code === 'message_not_owned_by_app';
}

export function createTextStreamProcessor({ debounceMs = DEFAULT_TEXT_DEBOUNCE_MS } = {}) {
  const turns = new Map();

  const clearState = (key) => {
    const state = turns.get(key);
    if (state?.timer) clearTimeout(state.timer);
    turns.delete(key);
  };

  const deliver = async (key) => {
    const state = turns.get(key);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const text = state.texts.join('\n').trim();
    state.texts = [];
    if (!text) return;

    const { ctx } = state;
    if (ctx?.deferDeliveryUntilResult || ctx?.channelSemantics === 'silent') return;
    const turn = ctx?.turn;
    const taskCardState = turn?.taskCardState;
    const streamId = taskCardState?.streamId;

    if (streamId && !taskCardState?.failed && ctx?.orchestrator) {
      try {
        await ctx.orchestrator.emit({
          turnId: key,
          attemptId: ctx?.task?.attemptId || '',
          channel: ctx?.channel || ctx?.task?.channel || '',
          threadTs: ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs || '',
          platform: ctx?.platform || ctx?.adapter?.platform || 'slack',
          channelSemantics: ctx?.channelSemantics,
          intent: ASSISTANT_TEXT_DELTA,
          text,
          source: 'subscriber.text',
          meta: { streamId, sequence: state.sequence = (state.sequence || 0) + 1 },
        });
      } catch (err) {
        if (taskCardState) taskCardState.failed = true;
        if (isStreamOwnershipError(err)) {
          warn(TAG, `[text] stream ownership lost, skipping subscriber delivery: ${err?.data?.error || err?.code}`);
        } else {
          warn(TAG, `[text] append failed: ${err.message}`);
        }
      }
    }
  };

  return {
    async handle(msg, ctx = {}) {
      const key = getTurnKey(msg.turnId);
      if (msg.eventType === 'result' || msg.eventType === 'turn_abort') {
        await deliver(key);
        clearState(key);
        return;
      }

      if (msg.eventType !== 'text') return;
      const text = String(msg.payload?.text || '').trim();
      if (!text) return;
      let state = turns.get(key);
      if (!state) {
        state = { texts: [], timer: null, ctx };
        turns.set(key, state);
      }
      state.ctx = ctx;
      state.texts.push(text);
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        deliver(key).catch((err) => warn(TAG, `[text] debounce deliver failed: ${err.message}`));
      }, debounceMs);
      if (typeof state.timer.unref === 'function') state.timer.unref();
    },
    clear(turnId) {
      clearState(getTurnKey(turnId));
    },
  };
}
