import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abandonTurnState,
  buildQiSettledChunks,
  closeQiStreamState,
  ensureTaskCardStreamStarted,
  makeTaskCardState,
  subtractDeliveredText,
} from '../src/scheduler.js';
import { EgressGate } from '../src/egress.js';

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

test('stream lifecycle: task card start, append, stop sequence is adapter-driven', async () => {
  const adapter = createMockAdapter();
  const taskCardState = makeTaskCardState({ enabled: true });
  taskCardState.displayMode = 'plan';
  taskCardState.taskCards.set('t1', { title: 'Read file', details: '', status: 'in_progress', output: '' });

  const started = await ensureTaskCardStreamStarted({
    taskCardState,
    hasTaskCardThread: () => true,
    disableTaskCardStreaming: () => {},
    adapter,
    channel: 'C1',
    effectiveThreadTs: '111.222',
    teamId: 'T1',
    buildTaskCardChunks: () => [{ type: 'task_update', id: 't1', title: 'Read file', status: 'in_progress' }],
    armKeepalive: () => {},
    failTaskCardStream: async (err) => { throw err; },
  });

  assert.equal(started, true);
  await adapter.appendStream(taskCardState.streamId, [{ type: 'task_update', id: 't1', status: 'complete' }]);
  await adapter.stopStream(taskCardState.streamId, { chunks: [] });
  assert.deepEqual(adapter.calls.map((call) => call[0]), ['startStream', 'appendStream', 'stopStream']);
});

test('rotate equivalent: EgressGate reset admits similar text after a stream boundary', () => {
  const gate = new EgressGate();
  assert.equal(gate.admit('继续分析...', 'before-rotate'), true);
  assert.equal(gate.admit('继续分析...', 'before-rotate-dup'), false);
  gate.reset();
  assert.equal(gate.admit('继续分析...', 'after-rotate'), true);
});

test('Qi lifecycle: finalize still stops stream when append fails', async () => {
  const adapter = createMockAdapter({ appendFails: true });
  const warnings = [];
  const turn = {
    qiStreamId: 'qi-1',
    qiStreamTs: '123.456',
    qiAppendPromise: null,
    qiStreamFailed: false,
  };

  await closeQiStreamState({
    turn,
    adapter,
    channel: 'C1',
    toolCount: 3,
    warnFn: (message) => warnings.push(message),
  });

  assert.deepEqual(adapter.calls.map((call) => call[0]), ['appendStream', 'stopStream']);
  assert.equal(turn.qiStreamId, null);
  assert.match(warnings.join('\n'), /append failed/);
  assert.equal(buildQiSettledChunks(3).at(-1).details, 'Distilled from 3 probes');
});

test('Qi abnormal exit and turn abandon close task-card and Qi streams', async () => {
  const adapter = createMockAdapter();
  const turn = {
    abandoned: false,
    statusRefreshTimer: setTimeout(() => {}, 10_000),
    taskCardState: makeTaskCardState({ enabled: true }),
    qiStreamId: 'qi-2',
    qiStreamTs: '222.333',
    qiAppendPromise: null,
    qiStreamFailed: false,
    egress: new EgressGate(),
  };
  turn.taskCardState.streamId = 'task-1';
  turn.taskCardState.taskCards.set('t1', { title: 'Work', details: '', status: 'in_progress', output: '' });

  await abandonTurnState({ turn, adapter, channel: 'C1' });

  assert.equal(turn.abandoned, true);
  assert.equal(turn.taskCardState.streamId, null);
  assert.equal(turn.qiStreamId, null);
  assert.deepEqual(adapter.calls.map((call) => call[0]), ['stopStream', 'appendStream', 'stopStream']);
});

test('result dedupe keeps text not delivered by intermediate_text', () => {
  const remaining = subtractDeliveredText('第一段\n第二段', ['第一段\n']);
  assert.equal(remaining, '第二段');
});
