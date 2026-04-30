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
    createQiSubscriber() {
      calls.push(['createQiSubscriber']);
      return { match: () => false, handle: async () => {} };
    },
    createPlanSubscriber() {
      calls.push(['createPlanSubscriber']);
      return { match: () => false, handle: async () => {} };
    },
    createTextSubscriber() {
      calls.push(['createTextSubscriber']);
      return { match: () => false, handle: async () => {} };
    },
    createStatusSubscriber() {
      calls.push(['createStatusSubscriber']);
      return { match: () => false, handle: async () => {} };
    },
  };
}

test('Scheduler addAdapter uses legacy Slack 4 subscriber factories when flag is off', () => {
  const previous = process.env.ORB_TURN_DELIVERY_CC_EVENT;
  delete process.env.ORB_TURN_DELIVERY_CC_EVENT;
  try {
    const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
    const adapter = createAdapter();

    scheduler.addAdapter('slack', adapter);

    assert.deepEqual(adapter.calls, [
      ['createQiSubscriber'],
      ['createPlanSubscriber'],
      ['createTextSubscriber'],
      ['createStatusSubscriber'],
    ]);
    assert.equal(typeof adapter.__orbQiSubscriberUnsubscribe, 'function');
    assert.equal(adapter.__orbTurnDeliveryCcEventUnsubscribe, undefined);
  } finally {
    if (previous == null) delete process.env.ORB_TURN_DELIVERY_CC_EVENT;
    else process.env.ORB_TURN_DELIVERY_CC_EVENT = previous;
  }
});

test('Scheduler addAdapter uses turn-delivery unified subscriber when flag is on', () => {
  const previous = process.env.ORB_TURN_DELIVERY_CC_EVENT;
  process.env.ORB_TURN_DELIVERY_CC_EVENT = '1';
  try {
    const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
    const adapter = createAdapter();

    scheduler.addAdapter('slack', adapter);

    assert.deepEqual(adapter.calls, []);
    assert.equal(typeof adapter.__orbTurnDeliveryCcEventUnsubscribe, 'function');
    assert.equal(typeof adapter.__orbTurnDeliveryCcEventSubscriber?.handle, 'function');
    assert.equal(adapter.__orbQiSubscriberUnsubscribe, undefined);
  } finally {
    if (previous == null) delete process.env.ORB_TURN_DELIVERY_CC_EVENT;
    else process.env.ORB_TURN_DELIVERY_CC_EVENT = previous;
  }
});
