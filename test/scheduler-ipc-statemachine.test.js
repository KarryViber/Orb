import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  abandonTurnState,
  EventBus,
  makeTaskCardState,
  Scheduler,
} from '../src/scheduler.js';

function createMockAdapter({ appendFails = false } = {}) {
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
      if (appendFails) throw new Error('append boom');
    },
    async stopStream(streamId, payload) {
      calls.push(['stopStream', streamId, payload]);
    },
    async editMessage(channel, ts, text) {
      calls.push(['editMessage', channel, ts, text]);
    },
  };
}

test('turn abandon clears scheduler-owned turn state', async () => {
  const adapter = createMockAdapter();
  const turn = {
    abandoned: false,
    statusRefreshTimer: setTimeout(() => {}, 10_000),
    taskCardState: makeTaskCardState({ enabled: true }),
  };

  await abandonTurnState({ turn, adapter, channel: 'C1' });

  assert.equal(turn.abandoned, true);
  assert.equal(turn.statusRefreshTimer, null);
  assert.deepEqual(adapter.calls, []);
});

test('EventBus publishes matching cc_event messages to subscribers', async () => {
  const bus = new EventBus();
  const received = [];
  bus.subscribe({
    match: (msg) => msg.type === 'cc_event' && msg.eventType === 'tool_use',
    handle: (msg, ctx) => received.push({ msg, ctx }),
  });

  const payload = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } };
  await bus.publish({ type: 'cc_event', turnId: 'turn-1', eventType: 'tool_use', payload }, { threadTs: '111.222' });

  assert.equal(received.length, 1);
  assert.equal(received[0].msg.turnId, 'turn-1');
  assert.equal(received[0].msg.payload, payload);
  assert.equal(received[0].ctx.threadTs, '111.222');
});

test('EventBus isolates subscriber errors and still publishes to later subscribers', async () => {
  const bus = new EventBus();
  const received = [];
  bus.subscribe(() => {
    throw new Error('subscriber boom');
  });
  bus.subscribe((msg) => received.push(msg.turnId));

  await assert.rejects(
    bus.publish({ type: 'cc_event', turnId: 'turn-error', eventType: 'result' }),
    (err) => err instanceof AggregateError && err.errors.length === 1,
  );

  assert.deepEqual(received, ['turn-error']);
});

test('EventBus times out a stuck subscriber and continues publishing', async () => {
  const bus = new EventBus({ subscriberTimeoutMs: 10 });
  const received = [];
  bus.subscribe(() => new Promise(() => {}));
  bus.subscribe((msg) => received.push(msg.turnId));

  await assert.rejects(
    bus.publish({ type: 'cc_event', turnId: 'turn-timeout', eventType: 'result' }),
    /EventBus publish failed/,
  );

  assert.deepEqual(received, ['turn-timeout']);
});

test('EventBus disables subscriber after three consecutive failures', async () => {
  const bus = new EventBus();
  const failingSubscriber = {
    name: 'failingSubscriber',
    handle() {
      throw new Error('subscriber boom');
    },
  };
  bus.subscribe(failingSubscriber);

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      bus.publish({ type: 'cc_event', turnId: `turn-${i}`, eventType: 'result' }),
      /EventBus publish failed/,
    );
  }

  assert.equal(bus.subscribers.has(failingSubscriber), false);
  await bus.publish({ type: 'cc_event', turnId: 'turn-disabled', eventType: 'result' });
});

test('Scheduler cc_event route publishes fake tool_use without handling legacy IPC branches', async () => {
  const scheduler = new Scheduler({ getProfile: () => ({ name: 'test' }), startPermissionServer: false });
  const received = [];
  scheduler.eventBus.subscribe((msg, ctx) => received.push({ msg, ctx }));

  const payload = { type: 'tool_use', id: 'toolu_fake', name: 'Bash', input: { command: 'echo fake' } };
  await scheduler._publishWorkerCcEvent(
    { type: 'cc_event', turnId: 'turn-fake', eventType: 'tool_use', payload },
    { threadTs: '123.456', platform: 'slack' },
  );

  assert.equal(received.length, 1);
  assert.equal(received[0].msg.payload, payload);
  assert.equal(received[0].ctx.scheduler, scheduler);
  assert.equal(received[0].ctx.threadTs, '123.456');
});

test('Scheduler records lesson candidate when EventBus subscriber fails', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orb-eventbus-failure-'));
  const scheduler = new Scheduler({ getProfile: () => ({ name: 'test', dataDir }), startPermissionServer: false });
  scheduler.eventBus.subscribe({
    name: 'lessonFailingSubscriber',
    handle() {
      throw new Error('subscriber exploded');
    },
  });

  await assert.rejects(
    scheduler._publishWorkerCcEvent(
      { type: 'cc_event', turnId: 'turn-fail', eventType: 'tool_use', payload: { name: 'Bash' } },
      {
        threadTs: '123.456',
        profile: { name: 'test', dataDir },
        task: { origin: { kind: 'user', name: 'first-touch', parentAttemptId: null } },
      },
    ),
    /EventBus publish failed/,
  );

  const candidateDir = join(dataDir, 'lesson-candidates');
  const files = readdirSync(candidateDir).filter((name) => name.includes('event-bus-subscriber-failed'));
  assert.equal(files.length, 1);
  const text = readFileSync(join(candidateDir, files[0]), 'utf8');
  assert.match(text, /event-bus-subscriber-failed/);
  assert.match(text, /lessonFailingSubscriber/);
  assert.match(text, /tool_use/);
});
