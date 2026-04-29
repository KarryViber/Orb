import test from 'node:test';
import assert from 'node:assert/strict';
import { abandonTurnState } from '../src/scheduler.js';

test('abandonTurnState clears active wechat thread status', async () => {
  const calls = [];
  const adapter = {
    async setThreadStatus(channel, threadTs, status, loadingMessages) {
      calls.push({ channel, threadTs, status, loadingMessages });
    },
  };
  const turn = {
    abandoned: false,
    typingActive: true,
    pendingThreadStatus: 'Cooking...',
    pendingStatusLoadingMessages: ['Cooking...'],
    statusRefreshTimer: setTimeout(() => {}, 10_000),
  };

  await abandonTurnState({
    turn,
    adapter,
    channel: 'wx-user-1',
    threadTs: 'wx-user-1',
  });

  assert.equal(turn.abandoned, true);
  assert.equal(turn.typingActive, false);
  assert.equal(turn.pendingThreadStatus, '');
  assert.equal(turn.statusRefreshTimer, null);
  assert.deepEqual(calls, [{
    channel: 'wx-user-1',
    threadTs: 'wx-user-1',
    status: '',
    loadingMessages: null,
  }]);
});
