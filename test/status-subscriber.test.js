import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackStatusSubscriber } from '../src/adapters/slack.js';
import { EventBus, Scheduler } from '../src/scheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockAdapter() {
  return {
    async deliver() {
      return { ts: null };
    },
    createStatusSubscriber() {
      return createSlackStatusSubscriber(this, { heartbeatMs: 10 });
    },
  };
}

function toolUse(turnId, name, input = {}) {
  return { type: 'cc_event', turnId, eventType: 'tool_use', payload: { type: 'tool_use', id: `${turnId}-${name}`, name, input } };
}

test('SlackStatusSubscriber sets status on tool_use and refreshes long-running tools', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackStatusSubscriber(adapter, { heartbeatMs: 10 }));
  const statuses = [];
  const ctx = {
    async applyThreadStatus(status) {
      statuses.push(status);
    },
  };

  await bus.publish(toolUse('turn-status', 'Bash', { description: 'Run tests' }), ctx);
  await sleep(25);
  await bus.publish({ type: 'cc_event', turnId: 'turn-status', eventType: 'result', payload: {} }, ctx);

  assert.match(statuses[0], /^Bash: Run tests$/);
  assert.equal(statuses.some((status) => /^Bash: Run tests \(\d+s\)$/.test(status)), true);
  assert.equal(statuses.at(-1), '');
});

test('SlackStatusSubscriber ignores deferred turns', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackStatusSubscriber(adapter, { heartbeatMs: 10 }));
  const statuses = [];

  await bus.publish(toolUse('turn-deferred', 'Bash', { description: 'Run tests' }), {
    deferDeliveryUntilResult: true,
    async applyThreadStatus(status) {
      statuses.push(status);
    },
  });
  await sleep(15);

  assert.deepEqual(statuses, []);
});

test('Scheduler registers Slack status subscriber when Slack adapter is added', () => {
  const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
  const adapter = createMockAdapter();
  scheduler.addAdapter('slack', adapter);

  assert.equal(typeof adapter.__orbStatusSubscriberUnsubscribe, 'function');
  adapter.__orbStatusSubscriberUnsubscribe();
});
