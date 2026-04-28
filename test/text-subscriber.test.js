import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackTextSubscriber } from '../src/adapters/slack.js';
import { EventBus, Scheduler } from '../src/scheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockAdapter() {
  const calls = [];
  return {
    calls,
    buildPayloads(text) {
      return [{ text }];
    },
    async appendStream(streamId, chunks) {
      calls.push(['appendStream', streamId, chunks]);
    },
    async sendReply(channel, threadTs, text, extra = {}) {
      calls.push(['sendReply', channel, threadTs, text, extra]);
    },
    createTextSubscriber() {
      return createSlackTextSubscriber(this, { debounceMs: 10 });
    },
  };
}

function textEvent(turnId, text) {
  return { type: 'cc_event', turnId, eventType: 'text', payload: { type: 'text', text } };
}

function createTurn(streamId = null) {
  const deliveredTexts = [];
  return {
    intermediateDeliveredThisTurn: false,
    taskCardState: { streamId, failed: false },
    egress: {
      deliveredTexts,
      admit(text) {
        deliveredTexts.push(text);
        return true;
      },
    },
  };
}

test('SlackTextSubscriber debounces text and appends markdown_text to an open stream', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackTextSubscriber(adapter, { debounceMs: 10 }));
  const turn = createTurn('stream-1');
  const ctx = { channel: 'C1', effectiveThreadTs: '111.222', turn };

  await bus.publish(textEvent('turn-text', 'first'), ctx);
  await bus.publish(textEvent('turn-text', 'second'), ctx);
  await sleep(25);

  assert.deepEqual(adapter.calls, [
    ['appendStream', 'stream-1', [{ type: 'markdown_text', text: 'first\nsecond' }]],
  ]);
  assert.equal(turn.intermediateDeliveredThisTurn, true);
  assert.deepEqual(turn.egress.deliveredTexts, ['first\nsecond']);
});

test('SlackTextSubscriber marks task card failed without sendReply fallback when stream ownership is lost', async () => {
  const adapter = createMockAdapter();
  adapter.appendStream = async (streamId, chunks) => {
    adapter.calls.push(['appendStream', streamId, chunks]);
    throw Object.assign(new Error('not in streaming state'), { data: { error: 'message_not_in_streaming_state' } });
  };
  const bus = new EventBus();
  bus.subscribe(createSlackTextSubscriber(adapter, { debounceMs: 10 }));
  const turn = createTurn('stream-1');
  const ctx = { channel: 'C1', effectiveThreadTs: '111.222', turn };

  await bus.publish(textEvent('turn-stream-failed', 'plain text'), ctx);
  await sleep(25);

  assert.deepEqual(adapter.calls, [['appendStream', 'stream-1', [{ type: 'markdown_text', text: 'plain text' }]]]);
});

test('SlackTextSubscriber flushes pending text immediately on result', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackTextSubscriber(adapter, { debounceMs: 1000 }));
  const turn = createTurn('stream-1');
  const ctx = { channel: 'C1', effectiveThreadTs: '111.222', turn };

  await bus.publish(textEvent('turn-flush', 'pending'), ctx);
  await bus.publish({ type: 'cc_event', turnId: 'turn-flush', eventType: 'result', payload: {} }, ctx);

  assert.deepEqual(adapter.calls, [
    ['appendStream', 'stream-1', [{ type: 'markdown_text', text: 'pending' }]],
  ]);
});

test('Scheduler registers Slack text subscriber when Slack adapter is added', () => {
  const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
  const adapter = createMockAdapter();
  scheduler.addAdapter('slack', adapter);

  assert.equal(typeof adapter.__orbTextSubscriberUnsubscribe, 'function');
  adapter.__orbTextSubscriberUnsubscribe();
});
