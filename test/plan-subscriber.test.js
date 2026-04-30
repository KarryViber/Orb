import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackPlanSubscriber } from '../src/adapters/slack.js';
import { EventBus, Scheduler } from '../src/scheduler.js';
import { TurnDeliveryOrchestrator } from '../src/turn-delivery/orchestrator.js';

function createMockAdapter() {
  const calls = [];
  let streamSeq = 0;
  return {
    calls,
    async startStream(channel, threadTs, options) {
      streamSeq += 1;
      const stream = { stream_id: `plan-stream-${streamSeq}`, ts: `${streamSeq}.000` };
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
      }
      return { ts: turnState.streamMessageTs || null };
    },
    createPlanSubscriber() {
      return createSlackPlanSubscriber(this);
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
  });
  ctx.orchestrator = orchestrator;
  ctx.task = { ...(ctx.task || {}), attemptId: 'attempt-1' };
}

function todoWrite(turnId, todos) {
  return {
    type: 'cc_event',
    turnId,
    eventType: 'tool_use',
    payload: {
      type: 'tool_use',
      id: `${turnId}-todo`,
      name: 'TodoWrite',
      input: { todos },
    },
  };
}

test('SlackPlanSubscriber renders TodoWrite rows and replaces snapshot on later TodoWrite', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackPlanSubscriber(adapter));
  const ctx = { channel: 'C1', threadTs: '111.222', effectiveThreadTs: '111.222', task: { teamId: 'T1' } };
  attachOrchestrator(adapter, ctx, 'turn-plan');

  await bus.publish(todoWrite('turn-plan', [
    { content: '第一步', status: 'in_progress' },
    { content: '第二步', status: 'pending' },
  ]), ctx);

  await bus.publish(todoWrite('turn-plan', [
    { content: '第一步', status: 'completed' },
    { content: '第二步', status: 'in_progress' },
    { content: '第三步', status: 'pending' },
  ]), ctx);

  await bus.publish({ type: 'cc_event', turnId: 'turn-plan', eventType: 'result', payload: { stop_reason: 'end_turn' } }, ctx);

  const startCalls = adapter.calls.filter((call) => call[0] === 'startStream');
  const appendCalls = adapter.calls.filter((call) => call[0] === 'appendStream');
  const stopCalls = adapter.calls.filter((call) => call[0] === 'stopStream');

  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0][1], 'C1');
  assert.equal(startCalls[0][2], '111.222');
  assert.equal(startCalls[0][3].task_display_mode, 'plan');
  assert.deepEqual(startCalls[0][3].initial_chunks, [
    { type: 'plan_update', title: '进度 0/2｜第一步' },
    { type: 'task_update', id: 'todowrite-todo-0', title: '第一步', status: 'in_progress' },
    { type: 'task_update', id: 'todowrite-todo-1', title: '第二步', status: 'pending' },
  ]);

  assert.equal(appendCalls.length, 1);
  assert.deepEqual(appendCalls[0], ['appendStream', 'plan-stream-1', [
    { type: 'plan_update', title: '进度 1/3｜第二步' },
    { type: 'task_update', id: 'todowrite-todo-0', title: '第一步', status: 'complete' },
    { type: 'task_update', id: 'todowrite-todo-1', title: '第二步', status: 'in_progress' },
    { type: 'task_update', id: 'todowrite-todo-2', title: '第三步', status: 'pending' },
  ]]);

  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0][1], 'plan-stream-1');
  assert.deepEqual(stopCalls[0][2].chunks, appendCalls[0][2]);
});

test('SlackPlanSubscriber ignores non-TodoWrite and empty TodoWrite events', async () => {
  const adapter = createMockAdapter();
  const bus = new EventBus();
  bus.subscribe(createSlackPlanSubscriber(adapter));
  const ctx = { channel: 'C1', threadTs: '111.222' };

  await bus.publish({ type: 'cc_event', turnId: 'turn-empty', eventType: 'tool_use', payload: { name: 'Bash', input: {} } }, ctx);
  await bus.publish(todoWrite('turn-empty', []), ctx);
  await bus.publish({ type: 'cc_event', turnId: 'turn-empty', eventType: 'result', payload: {} }, ctx);

  assert.deepEqual(adapter.calls, []);
});

test('Scheduler registers Slack plan subscriber when Slack adapter is added', () => {
  const previous = process.env.ORB_TURN_DELIVERY_CC_EVENT;
  process.env.ORB_TURN_DELIVERY_CC_EVENT = '0';
  try {
    const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
    const adapter = createMockAdapter();
    scheduler.addAdapter('slack', adapter);

    assert.equal(typeof adapter.__orbPlanSubscriberUnsubscribe, 'function');
    adapter.__orbPlanSubscriberUnsubscribe();
  } finally {
    if (previous == null) delete process.env.ORB_TURN_DELIVERY_CC_EVENT;
    else process.env.ORB_TURN_DELIVERY_CC_EVENT = previous;
  }
});
