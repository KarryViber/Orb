import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackQiSubscriber, createSlackTextSubscriber } from '../src/adapters/slack.js';
import { categorizeTool } from '../src/adapters/slack-format.js';
import { EventBus, Scheduler } from '../src/scheduler.js';
import { TurnDeliveryOrchestrator } from '../src/turn-delivery/orchestrator.js';

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
    get capabilities() {
      return { stream: true };
    },
    async deliver(intent, { channel, turnState }) {
      if (channel !== 'stream') return { ts: null };
      if (intent.intent === 'task_progress.start') {
        return this.startStream(intent.channel, intent.threadTs, {
          task_display_mode: intent.meta.task_display_mode,
          initial_chunks: intent.meta.chunks,
          team_id: intent.meta.teamId,
        });
      }
      if (intent.intent === 'task_progress.append') {
        await this.appendStream(turnState.streamId, intent.meta.chunks);
      } else if (intent.intent === 'task_progress.stop') {
        await this.stopStream(turnState.streamId, { chunks: intent.meta.chunks });
      } else if (intent.intent === 'assistant_text.delta') {
        await this.appendStream(turnState.streamId, [{ type: 'markdown_text', text: intent.text }]);
      }
      return { ts: turnState.streamMessageTs || null };
    },
    createQiSubscriber() {
      return createSlackQiSubscriber(this);
    },
  };
}

function attachOrchestrator(adapter, ctx, turnId) {
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn({
    turnId,
    attemptId: 'attempt-1',
    channel: ctx.channel,
    threadTs: ctx.effectiveThreadTs || ctx.threadTs,
    platform: 'slack',
    taskCardState: ctx.turn?.taskCardState || null,
  });
  ctx.orchestrator = orchestrator;
  ctx.task = { ...(ctx.task || {}), attemptId: 'attempt-1' };
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
  attachOrchestrator(adapter, ctx, 'turn-1');

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

test('SlackQiSubscriber exposes stream id for text subscriber appends', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackQiSubscriber(adapter));
  bus.subscribe(createSlackTextSubscriber(adapter, { debounceMs: 10 }));
  const turn = {
    taskCardState: { enabled: true, deferred: false, streamId: null, failed: false },
  };
  const ctx = { channel: 'C1', threadTs: '111.222', effectiveThreadTs: '111.222', platform: 'slack', turn };
  attachOrchestrator(adapter, ctx, 'turn-shared-stream');

  await bus.publish(toolUse('turn-shared-stream', 'Bash', { description: 'Run tests' }), ctx);
  assert.equal(turn.taskCardState.streamId, 'stream-1');

  await bus.publish({ type: 'cc_event', turnId: 'turn-shared-stream', eventType: 'text', payload: { text: 'streamed text' } }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(adapter.calls.at(-1), ['appendStream', 'stream-1', [{ type: 'markdown_text', text: 'streamed text' }]]);

  await bus.publish({ type: 'cc_event', turnId: 'turn-shared-stream', eventType: 'result', payload: { stop_reason: 'end_turn' } }, ctx);
  assert.equal(turn.taskCardState.streamId, null);
});

test('SlackQiSubscriber serializes concurrent tool_use appends', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackQiSubscriber(adapter));
  const ctx = { channel: 'C1', threadTs: '222.333', effectiveThreadTs: '222.333' };
  attachOrchestrator(adapter, ctx, 'turn-serial');

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
