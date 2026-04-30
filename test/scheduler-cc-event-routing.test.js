import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

function createAdapter() {
  const calls = [];
  return {
    calls,
    get platform() {
      return 'slack';
    },
    async deliver() {
      calls.push(['deliver']);
      return { ts: null };
    },
  };
}

test('Scheduler addAdapter always uses turn-delivery unified subscriber', () => {
  const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
  const adapter = createAdapter();

  scheduler.addAdapter('slack', adapter);

  assert.deepEqual(adapter.calls, []);
  assert.equal(typeof adapter.__orbTurnDeliveryCcEventUnsubscribe, 'function');
  assert.equal(typeof adapter.__orbTurnDeliveryCcEventSubscriber?.handle, 'function');
  assert.equal(adapter.__orbQiSubscriberUnsubscribe, undefined);
});
