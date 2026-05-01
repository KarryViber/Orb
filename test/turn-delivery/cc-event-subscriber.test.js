import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/scheduler.js';
import { TurnDeliveryOrchestrator } from '../../src/turn-delivery/orchestrator.js';
import { createTurnDeliveryCcEventSubscriber } from '../../src/turn-delivery/cc-event-subscriber.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockAdapter({ failAppend = false } = {}) {
  const calls = [];
  let streamSeq = 0;
  return {
    calls,
    get platform() {
      return 'slack';
    },
    get capabilities() {
      return { stream: true, metadata: true };
    },
    async startStream(channel, threadTs, options) {
      streamSeq += 1;
      const stream = { stream_id: `stream-${streamSeq}`, ts: `${streamSeq}.000` };
      calls.push(['startStream', channel, threadTs, options, stream]);
      return stream;
    },
    async appendStream(streamId, chunks) {
      calls.push(['appendStream', streamId, chunks]);
      if (failAppend) {
        throw Object.assign(new Error('not in streaming state'), { data: { error: 'message_not_in_streaming_state' } });
      }
    },
    async stopStream(streamId, payload) {
      calls.push(['stopStream', streamId, payload]);
    },
    async setThreadStatus(channel, threadTs, status) {
      calls.push(['setThreadStatus', channel, threadTs, status]);
    },
    async deliver(intent, { channel, turnState }) {
      if (channel === 'stream') {
        if (intent.intent === 'task_progress.start') {
          return this.startStream(intent.channel, intent.threadTs, {
            task_display_mode: intent.meta.task_display_mode,
            initial_chunks: intent.meta.chunks,
            team_id: intent.meta.teamId,
          });
        }
        if (intent.intent === 'task_progress.append') {
          await this.appendStream(intent.meta.streamId || turnState.streamId, intent.meta.chunks);
        } else if (intent.intent === 'task_progress.stop') {
          await this.stopStream(intent.meta.streamId || turnState.streamId, { chunks: intent.meta.chunks });
        } else if (intent.intent === 'assistant_text.delta') {
          await this.appendStream(turnState.streamId, [{ type: 'markdown_text', text: intent.text }]);
        }
        return { ts: turnState.streamMessageTs || null };
      }
      if (channel === 'metadata') {
        await this.setThreadStatus(intent.channel, intent.threadTs, intent.text);
      }
      return { ts: null };
    },
  };
}

function createCtx(adapter, turnId, extra = {}) {
  const turn = {
    taskCardStates: {
      qi: { enabled: true, deferred: false, streamId: null, streamMessageTs: null, failed: false },
      plan: { enabled: true, deferred: false, streamId: null, streamMessageTs: null, failed: false },
    },
  };
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  const ctx = {
    channel: 'C1',
    threadTs: '111.222',
    effectiveThreadTs: '111.222',
    platform: 'slack',
    adapter,
    turn,
    task: { attemptId: 'attempt-1', teamId: 'T1' },
    orchestrator,
    ...extra,
  };
  orchestrator.beginTurn({
    turnId,
    attemptId: 'attempt-1',
    channel: ctx.channel,
    threadTs: ctx.effectiveThreadTs,
    platform: 'slack',
    channelSemantics: ctx.channelSemantics,
    taskCardStates: turn.taskCardStates,
  });
  return ctx;
}

function toolUse(turnId, name, input = {}) {
  return { type: 'cc_event', turnId, eventType: 'tool_use', payload: { type: 'tool_use', id: `${turnId}-${name}`, name, input } };
}

function textEvent(turnId, text) {
  return { type: 'cc_event', turnId, eventType: 'text', payload: { type: 'text', text } };
}

test('turn-delivery unified subscriber dispatches Qi, text, status, and result cleanup', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 10, statusHeartbeatMs: 10 }));
  const ctx = createCtx(adapter, 'turn-unified');

  await bus.publish(toolUse('turn-unified', 'Bash', { description: 'Run tests' }), ctx);
  assert.equal(ctx.turn.taskCardStates.qi.streamId, 'stream-1');
  assert.deepEqual(adapter.calls[0].slice(0, 3), ['startStream', 'C1', '111.222']);
  assert.deepEqual(adapter.calls.at(-1), ['setThreadStatus', 'C1', '111.222', 'Bash: Run tests']);

  await bus.publish(textEvent('turn-unified', 'first'), ctx);
  await sleep(25);
  assert.equal(adapter.calls.some((call) => (
    call[0] === 'appendStream'
    && call[1] === 'stream-1'
    && call[2]?.[0]?.type === 'markdown_text'
    && call[2]?.[0]?.text === 'first'
  )), true);

  await bus.publish({ type: 'cc_event', turnId: 'turn-unified', eventType: 'result', payload: { stop_reason: 'end_turn' } }, ctx);
  assert.equal(ctx.turn.taskCardStates.qi.streamId, null);
  assert.equal(adapter.calls.some((call) => call[0] === 'stopStream'), true);
  assert.deepEqual(adapter.calls.at(-1), ['setThreadStatus', 'C1', '111.222', '']);
});

test('turn-delivery unified subscriber renders TodoWrite plan stream', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 1 }));
  const ctx = createCtx(adapter, 'turn-plan');

  await bus.publish(toolUse('turn-plan', 'TodoWrite', {
    todos: [
      { content: 'Inspect scheduler', status: 'completed' },
      { content: 'Move subscriber', status: 'in_progress' },
    ],
  }), ctx);
  await bus.publish({ type: 'cc_event', turnId: 'turn-plan', eventType: 'result', payload: {} }, ctx);

  const start = adapter.calls.find((call) => call[0] === 'startStream');
  assert.match(start[3].initial_chunks[0].title, /进度 1\/2/);
  assert.deepEqual(start[3].initial_chunks.slice(1).map((chunk) => [chunk.title, chunk.status]), [
    ['Inspect scheduler', 'complete'],
    ['Move subscriber', 'in_progress'],
  ]);
  const planAppend = adapter.calls.find((call) => (
    call[0] === 'appendStream'
    && call[1] === start[4].stream_id
    && call[2]?.some((chunk) => String(chunk.id || '').startsWith('todowrite-todo-'))
  ));
  assert.ok(planAppend);
});

test('turn-delivery text stream marks task card failed on Slack ownership loss', async () => {
  const adapter = createMockAdapter({ failAppend: true });
  const bus = new EventBus();
  bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 1 }));
  const ctx = createCtx(adapter, 'turn-fail');

  await bus.publish(toolUse('turn-fail', 'Bash', { description: 'Run tests' }), ctx);
  await bus.publish(textEvent('turn-fail', 'plain text'), ctx);
  await sleep(15);

  assert.equal(ctx.turn.taskCardStates.qi.failed, true);
});

test('turn-delivery starts separate Qi and TodoWrite streams in either order', async () => {
  for (const [label, events] of [
    ['qi-first', [
      toolUse('turn-split-qi-first', 'Bash', { description: 'Run tests' }),
      toolUse('turn-split-qi-first', 'TodoWrite', { todos: [{ content: 'Plan', status: 'in_progress' }] }),
    ]],
    ['plan-first', [
      toolUse('turn-split-plan-first', 'TodoWrite', { todos: [{ content: 'Plan', status: 'in_progress' }] }),
      toolUse('turn-split-plan-first', 'Bash', { description: 'Run tests' }),
    ]],
  ]) {
    const adapter = createMockAdapter();
    const bus = new EventBus();
    bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 1 }));
    const turnId = `turn-split-${label}`;
    const ctx = createCtx(adapter, turnId);

    for (const event of events) await bus.publish(event, ctx);

    const starts = adapter.calls.filter((call) => call[0] === 'startStream');
    assert.equal(starts.length, 2);
    assert.deepEqual(new Set([
      ctx.turn.taskCardStates.qi.streamId,
      ctx.turn.taskCardStates.plan.streamId,
    ]).size, 2);
    assert.equal(starts.some((call) => call[3].initial_chunks.some((chunk) => chunk.id === 'qi-exec')), true);
    assert.equal(starts.some((call) => call[3].initial_chunks.some((chunk) => String(chunk.id || '').startsWith('todowrite-todo-'))), true);
  }
});

test('turn-delivery unified subscriber suppresses silent and deferred middle-state delivery', async () => {
  for (const extra of [{ channelSemantics: 'silent' }, { deferDeliveryUntilResult: true }]) {
    const adapter = createMockAdapter();
    const bus = new EventBus();
    bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 1, statusHeartbeatMs: 1 }));
    const ctx = createCtx(adapter, `turn-${Object.keys(extra)[0]}`, extra);

    await bus.publish(toolUse(ctx.orchestrator.getTurnState(`turn-${Object.keys(extra)[0]}`)?.turnId, 'Bash', { description: 'Hidden' }), ctx);
    await bus.publish(textEvent(`turn-${Object.keys(extra)[0]}`, 'hidden text'), ctx);
    await sleep(10);

    assert.deepEqual(adapter.calls, []);
  }
});

test('turn-delivery unified subscriber ignores non-Slack platform contexts', async () => {
  const adapter = createMockAdapter();
  const subscriber = createTurnDeliveryCcEventSubscriber();
  const ctx = createCtx(adapter, 'turn-wechat', { platform: 'wechat' });
  assert.equal(subscriber.match(toolUse('turn-wechat', 'Bash', {}), ctx), false);
});
