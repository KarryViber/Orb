import { warn } from '../log.js';

const TAG = 'scheduler';

export function makeTaskCardState({ enabled = false, deferred = false } = {}) {
  return {
    enabled: Boolean(enabled),
    deferred: Boolean(deferred),
    streamId: null,
    streamMessageTs: null,
    failed: false,
  };
}

export function makeTaskCardStates(config = {}) {
  return {
    qi: makeTaskCardState(config),
    plan: makeTaskCardState(config),
  };
}

export function createTurnState(taskCardConfig) {
  return {
    typingActive: false,
    pendingThreadStatus: '',
    pendingStatusLoadingMessages: null,
    statusRefreshTimer: null,
    abandoned: false,
    taskCardStates: makeTaskCardStates(taskCardConfig),
  };
}

export async function abandonTurnState({
  turn,
  adapter,
  channel,
  threadTs,
  canManageThreadStatus = channel != null && threadTs != null && typeof adapter?.setThreadStatus === 'function',
}) {
  if (!turn || turn.abandoned) return false;
  const shouldClearThreadStatus = Boolean(turn.typingActive && canManageThreadStatus);
  turn.abandoned = true;
  if (turn.statusRefreshTimer) {
    clearTimeout(turn.statusRefreshTimer);
    turn.statusRefreshTimer = null;
  }
  if (shouldClearThreadStatus) {
    try {
      await adapter.setThreadStatus(channel, threadTs, '', null);
      turn.typingActive = false;
      turn.pendingThreadStatus = '';
      turn.pendingStatusLoadingMessages = null;
    } catch (err) {
      warn(TAG, `failed to clear abandoned thread status: ${err.message}`);
    }
  }
  return true;
}

function clearStatusRefresh(turn) {
  if (turn?.statusRefreshTimer) {
    clearTimeout(turn.statusRefreshTimer);
    turn.statusRefreshTimer = null;
  }
}
