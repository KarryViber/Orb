import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlackPlanSubscriber,
  createSlackQiSubscriber,
  createSlackStatusSubscriber,
  createSlackTextSubscriber,
} from '../src/adapters/slack.js';
import { EventBus } from '../src/scheduler.js';

function createMockAdapter() {
  const calls = [];
  return {
    calls,
    async startStream(...args) { calls.push(['startStream', ...args]); },
    async appendStream(...args) { calls.push(['appendStream', ...args]); },
    async stopStream(...args) { calls.push(['stopStream', ...args]); },
    async sendReply(...args) { calls.push(['sendReply', ...args]); },
    buildPayloads(text) { return [{ text }]; },
  };
}

function createTurn() {
  return {
    taskCardState: { enabled: true, deferred: false, failed: false, streamId: null },
  };
}

const messages = {
  qi: { type: 'cc_event', turnId: 'turn-qi', eventType: 'tool_use', payload: { type: 'tool_use', name: 'Bash', input: { command: 'echo ok' } } },
  plan: { type: 'cc_event', turnId: 'turn-plan', eventType: 'tool_use', payload: { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'one', status: 'pending' }] } } },
  text: { type: 'cc_event', turnId: 'turn-text', eventType: 'text', payload: { type: 'text', text: 'hello' } },
  status: { type: 'cc_event', turnId: 'turn-status', eventType: 'tool_use', payload: { type: 'tool_use', name: 'Bash', input: { description: 'Run tests' } } },
};

test('Slack cc_event subscribers ignore non-Slack platform contexts', async () => {
  for (const platform of ['wechat', 'cron']) {
    const adapter = createMockAdapter();
    const subscribers = [
      createSlackQiSubscriber(adapter),
      createSlackPlanSubscriber(adapter),
      createSlackTextSubscriber(adapter, { debounceMs: 1 }),
      createSlackStatusSubscriber(adapter, { heartbeatMs: 1 }),
    ];
    const pairs = [
      [subscribers[0], messages.qi],
      [subscribers[1], messages.plan],
      [subscribers[2], messages.text],
      [subscribers[3], messages.status],
    ];
    const turn = createTurn();
    const ctx = {
      platform,
      channel: 'C1',
      threadTs: '111.222',
      effectiveThreadTs: '111.222',
      turn,
      applyThreadStatus() {
        adapter.calls.push(['applyThreadStatus']);
      },
    };

    for (const [subscriber, msg] of pairs) {
      assert.equal(subscriber.match(msg, ctx), false, `${platform} should not match ${msg.turnId}`);
    }

    const bus = new EventBus();
    for (const subscriber of subscribers) bus.subscribe(subscriber);
    for (const msg of Object.values(messages)) await bus.publish(msg, ctx);

    assert.deepEqual(adapter.calls, []);
  }
});
