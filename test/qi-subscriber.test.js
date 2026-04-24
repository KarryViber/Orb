import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackQiSubscriber } from '../src/adapters/slack.js';
import { categorizeTool } from '../src/adapters/slack-format.js';
import { EventBus, Scheduler } from '../src/scheduler.js';

function createMockAdapter() {
  const calls = [];
  let streamSeq = 0;
  return {
    calls,
    async startStream(channel, threadTs, options) {
      streamSeq += 1;
      const stream = { stream_id: `stream-${streamSeq}`, ts: `${streamSeq}.000` };
      calls.push(['startStream', channel, threadTs, options, stream]);
      return stream;
    },
    async appendStream(streamId, chunks) {
      calls.push(['appendStream', streamId, chunks]);
    },
    async stopStream(streamId, payload) {
      calls.push(['stopStream', streamId, payload]);
    },
    createQiSubscriber() {
      return createSlackQiSubscriber(this);
    },
  };
}

function toolUse(turnId, name, input = {}) {
  return { type: 'cc_event', turnId, eventType: 'tool_use', payload: { type: 'tool_use', id: `${turnId}-${name}`, name, input } };
}

test('categorizeTool maps Qi buckets', () => {
  assert.equal(categorizeTool('Bash'), 'Probe');
  assert.equal(categorizeTool('WebSearch'), 'Probe');
  assert.equal(categorizeTool('Task'), 'Delegate');
  assert.equal(categorizeTool('mcp__linear__list'), 'Delegate');
  assert.equal(categorizeTool('summary'), 'Distill');
  assert.equal(categorizeTool('TodoWrite'), null);
});

test('SlackQiSubscriber renders Qi stream from cc_event tool_use/result', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackQiSubscriber(adapter));
  const ctx = { channel: 'C1', threadTs: '111.222', effectiveThreadTs: '111.222', task: { teamId: 'T1' } };

  await bus.publish(toolUse('turn-1', 'Bash', { command: 'npm test', description: 'Run tests' }), ctx);
  await bus.publish(toolUse('turn-1', 'WebSearch', { query: 'OpenAI docs' }), ctx);
  await bus.publish(toolUse('turn-1', 'Task', { description: 'Investigate flaky test' }), ctx);
  await bus.publish({ type: 'cc_event', turnId: 'turn-1', eventType: 'result', payload: { stop_reason: 'end_turn' } }, ctx);

  const startCalls = adapter.calls.filter((call) => call[0] === 'startStream');
  const appendCalls = adapter.calls.filter((call) => call[0] === 'appendStream');
  const stopCalls = adapter.calls.filter((call) => call[0] === 'stopStream');

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0][3].task_display_mode, 'plan');
  assert.deepEqual(startCalls[0][3].initial_chunks.map((chunk) => chunk.id).filter(Boolean), ['qi-exec', 'qi-other', 'qi-summary']);

  assert.equal(appendCalls.length, 3);
  const detailsById = new Map();
  for (const [, , chunks] of appendCalls) {
    for (const chunk of chunks) {
      if (chunk.type === 'task_update' && chunk.details) {
        detailsById.set(chunk.id, `${detailsById.get(chunk.id) || ''}${chunk.details}`);
      }
    }
  }
  assert.match(detailsById.get('qi-exec'), /Bash: Run tests/);
  assert.match(detailsById.get('qi-exec'), /WebSearch: OpenAI docs/);
  assert.match(detailsById.get('qi-other'), /Task: Investigate flaky test/);

  assert.equal(stopCalls.length, 1);
  const finalChunks = stopCalls[0][2].chunks;
  assert.equal(finalChunks[0].type, 'plan_update');
  assert.equal(finalChunks[0].title, 'Settled');
  assert.deepEqual(
    finalChunks.filter((chunk) => chunk.type === 'task_update').map((chunk) => [chunk.id, chunk.status]),
    [['qi-exec', 'complete'], ['qi-other', 'complete'], ['qi-summary', 'complete']],
  );
  assert.match(finalChunks.find((chunk) => chunk.id === 'qi-summary').details, /Distilled from 3 probes/);
});

test('SlackQiSubscriber serializes concurrent tool_use appends', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackQiSubscriber(adapter));
  const ctx = { channel: 'C1', threadTs: '222.333', effectiveThreadTs: '222.333' };

  await Promise.all([
    bus.publish(toolUse('turn-serial', 'Bash', { description: 'first' }), ctx),
    bus.publish(toolUse('turn-serial', 'WebSearch', { query: 'second' }), ctx),
    bus.publish(toolUse('turn-serial', 'Task', { description: 'third' }), ctx),
  ]);

  const toolAppendLines = adapter.calls
    .filter((call) => call[0] === 'appendStream')
    .flatMap(([, , chunks]) => chunks)
    .filter((chunk) => chunk.details)
    .map((chunk) => chunk.details.trim());

  assert.deepEqual(toolAppendLines, ['Bash: first', 'WebSearch: second', 'Task: third']);
});

test('Scheduler registers Slack Qi subscriber when Slack adapter is added', () => {
  const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
  const adapter = createMockAdapter();
  scheduler.addAdapter('slack', adapter);

  assert.equal(typeof adapter.__orbQiSubscriberUnsubscribe, 'function');
  adapter.__orbQiSubscriberUnsubscribe();
});
