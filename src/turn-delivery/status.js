import { warn } from '../log.js';
import { METADATA_STATUS } from './intents.js';
import { buildStatusText, formatElapsedTime } from './cc-event-format.js';

const TAG = 'turn-delivery-cc-event';
const DEFAULT_STATUS_HEARTBEAT_MS = 90_000;

function getTurnKey(turnId) {
  return turnId || 'default';
}

function truncateStatus(text, max = 100) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

export function createStatusProcessor({ heartbeatMs = DEFAULT_STATUS_HEARTBEAT_MS } = {}) {
  const turns = new Map();

  const emitStatus = async (ctx, turnId, status) => {
    if (ctx?.orchestrator) {
      await ctx.orchestrator.emit({
        turnId,
        attemptId: ctx?.task?.attemptId || '',
        channel: ctx?.channel || ctx?.task?.channel || '',
        threadTs: ctx?.effectiveThreadTs || ctx?.threadTs || ctx?.task?.threadTs || '',
        platform: ctx?.platform || ctx?.adapter?.platform || 'slack',
        channelSemantics: ctx?.channelSemantics,
        intent: METADATA_STATUS,
        text: status,
        source: 'subscriber.status',
      });
      return;
    }
    if (typeof ctx?.applyThreadStatus === 'function') await ctx.applyThreadStatus(status);
  };

  const clearState = async (key, ctx) => {
    const state = turns.get(key);
    if (state?.timer) clearInterval(state.timer);
    turns.delete(key);
    await emitStatus(ctx || state?.ctx || {}, key, '');
  };

  const refresh = async (state, { includeElapsed = true } = {}) => {
    if (!turns.has(state?.key)) return;
    if (!state?.payload) return;
    const base = buildStatusText(state.payload);
    const status = includeElapsed && state.startedAt
      ? truncateStatus(`${base} (${formatElapsedTime(state.startedAt)})`, 100)
      : base;
    await emitStatus(state.ctx || {}, state.key, status);
  };

  return {
    async handle(msg, ctx = {}) {
      const key = getTurnKey(msg.turnId);
      if (msg.eventType === 'result' || msg.eventType === 'turn_abort') {
        await clearState(key, ctx);
        return;
      }

      if (msg.eventType !== 'tool_use') return;
      if (ctx?.deferDeliveryUntilResult || ctx?.channelSemantics === 'silent') return;
      const state = turns.get(key) || { payload: null, startedAt: 0, timer: null, ctx };
      state.key = key;
      state.payload = msg.payload || {};
      state.startedAt = Date.now();
      state.ctx = ctx;
      turns.set(key, state);
      await refresh(state, { includeElapsed: false });
      if (!state.timer) {
        state.timer = setInterval(() => {
          refresh(state).catch((err) => warn(TAG, `[status] heartbeat failed: ${err.message}`));
        }, heartbeatMs);
        if (typeof state.timer.unref === 'function') state.timer.unref();
      }
    },
    clear(turnId) {
      const key = getTurnKey(turnId);
      const state = turns.get(key);
      if (state?.timer) clearInterval(state.timer);
      turns.delete(key);
    },
    clearByContext({ channel, threadTs } = {}) {
      if (!channel || !threadTs) return;
      for (const [key, state] of turns.entries()) {
        const stCh = state.ctx?.channel || state.ctx?.task?.channel;
        const stTs = state.ctx?.effectiveThreadTs || state.ctx?.threadTs || state.ctx?.task?.threadTs;
        if (stCh === channel && stTs === threadTs) {
          if (state.timer) clearInterval(state.timer);
          turns.delete(key);
        }
      }
    },
  };
}
