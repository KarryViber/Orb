import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamClient } from '../../../src/adapters/slack/stream-client.js';
import { SlackAdapter } from '../../../src/adapters/slack.js';
import { TurnDeliveryOrchestrator } from '../../../src/turn-delivery/orchestrator.js';
import { createQiStreamProcessor } from '../../../src/turn-delivery/task-card-streams.js';

function streamClient(calls = [], options = {}) {
  let tsSeq = 0;
  return createStreamClient({
    webClient: {
      conversations: {
        async replies() {
          return { messages: [{ user: 'U1' }] };
        },
      },
      async apiCall(method, payload) {
        calls.push([method, payload]);
        if (method === 'chat.startStream') {
          tsSeq += 1;
          return { ok: true, ts: `1777.${tsSeq}` };
        }
        return { ok: true };
      },
    },
    getTeamId: () => 'T1',
    streamTrace: () => false,
    postReply: async () => ({ ts: '1777.2' }),
    ...options,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('normalizeStreamChunks converts text and task aliases into Slack stream chunks', () => {
  const client = streamClient();
  assert.deepEqual(client.normalizeStreamChunks([
    { type: 'text', text: '**hi**' },
    { type: 'task', id: 't1', title: 'Do it', status: 'completed' },
  ]), [
    { type: 'markdown_text', text: '*hi*' },
    { type: 'task_update', id: 't1', title: 'Do it', status: 'complete' },
  ]);
});

test('startStream calls Slack streaming API and stores handle for append', async () => {
  const calls = [];
  const client = streamClient(calls);
  const result = await client.startStream('C1', '111.222', { initial_chunks: [{ type: 'markdown_text', text: 'hello' }] });
  await client.appendStream(result.stream_id, [{ type: 'markdown_text', text: 'more' }]);
  assert.equal(result.stream_id, 'C1:1777.1');
  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream', 'chat.appendStream']);
});

test('startStream does not auto rotate when ORB_STREAM_AUTO_ROTATE is disabled', async () => {
  const calls = [];
  const client = streamClient(calls, { autoRotateEnabled: () => false });
  const result = await client.startStream('C1', '111.222', {
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
  });

  assert.deepEqual(await client.stopAndRotate(result.stream_id), {
    rotated: false,
    stream_id: result.stream_id,
    ts: '1777.1',
  });
  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream']);
});

test('auto rotate stops the old stream, starts a continued stream, and appends to the new message', async () => {
  const calls = [];
  const rotations = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    task_display_mode: 'plan',
    initial_chunks: [
      { type: 'plan_update', title: 'Orbiting...' },
      { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: '' },
    ],
    on_rotate: (rotation) => rotations.push(rotation),
  });
  await client.appendStream(result.stream_id, [
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: '\nBash: npm test\n' },
  ]);

  const rotated = await client.stopAndRotate(result.stream_id);
  await client.appendStream(rotated.stream_id, [{ type: 'markdown_text', text: 'after rotate' }]);

  assert.equal(rotated.stream_id, 'C1:1777.2');
  assert.deepEqual(calls.map(([method]) => method), [
    'chat.startStream',
    'chat.appendStream',
    'chat.stopStream',
    'chat.startStream',
    'chat.appendStream',
  ]);
  assert.equal(calls[2][1].ts, '1777.1');
  assert.equal(calls[2][1].chunks, undefined);
  assert.equal(calls[3][1].ts, undefined);
  assert.equal(calls[3][1].chunks[0].type, 'blocks');
  assert.equal(calls[3][1].chunks[0].blocks[0].elements[0].text, '↩️ 续');
  assert.deepEqual(calls[3][1].chunks[1], { type: 'plan_update', title: 'Orbiting...' });
  assert.deepEqual(calls[3][1].chunks[2], {
    type: 'task_update',
    id: 'qi-exec',
    title: 'Probe',
    status: 'in_progress',
    details: '\nBash: npm test\n',
  });
  assert.equal(calls[4][1].ts, '1777.2');
  assert.deepEqual(rotations.map((rotation) => rotation.reason), ['auto-rotate']);
});

test('auto rotate does not resend accumulated snapshot chunks while stopping previous stream', async () => {
  const calls = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    task_display_mode: 'plan',
    initial_chunks: [{ type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: '' }],
  });
  await client.appendStream(result.stream_id, [
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: 'A1\n' },
  ]);
  await client.appendStream(result.stream_id, [
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: 'A2\n' },
  ]);

  const rotated = await client.stopAndRotate(result.stream_id);
  await client.appendStream(rotated.stream_id, [
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'complete', details: 'A3\n' },
  ]);

  const stopCall = calls.find(([method]) => method === 'chat.stopStream');
  const rotatedStartCall = calls.filter(([method]) => method === 'chat.startStream')[1];
  const postRotateAppendCall = calls.at(-1);
  assert.equal(stopCall[1].chunks, undefined);
  assert.equal(rotatedStartCall[1].chunks[1].details, 'A1\nA2\n');
  assert.equal(postRotateAppendCall[1].chunks[0].details, 'A3\n');
});

test('auto rotate startStream failure marks turn streamFailed immediately', async () => {
  const calls = [];
  let tsSeq = 0;
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  adapter._teamId = 'T1';
  adapter._slack = {
    conversations: {
      async replies() {
        return { messages: [{ user: 'U1' }] };
      },
    },
    async apiCall(method, payload) {
      calls.push([method, payload]);
      if (method === 'chat.startStream') {
        tsSeq += 1;
        if (tsSeq === 2) throw Object.assign(new Error('start failed'), { data: { error: 'ratelimited' } });
        return { ok: true, ts: `1777.${tsSeq}` };
      }
      return { ok: true };
    },
  };
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  const taskCardStates = {
    qi: { enabled: true, deferred: false, streamId: null, streamMessageTs: null, failed: false },
  };
  const turnState = orchestrator.beginTurn({
    turnId: 'rotate-start-fail',
    attemptId: 'attempt-1',
    channel: 'C1',
    threadTs: '111.222',
    platform: 'slack',
    taskCardStates,
  });
  const processor = createQiStreamProcessor();

  await processor.handle({
    type: 'cc_event',
    turnId: 'rotate-start-fail',
    eventType: 'tool_use',
    payload: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { description: 'Run tests' } },
  }, {
    channel: 'C1',
    threadTs: '111.222',
    effectiveThreadTs: '111.222',
    platform: 'slack',
    adapter,
    turn: { taskCardStates },
    task: { attemptId: 'attempt-1', teamId: 'T1' },
    orchestrator,
  });

  await assert.rejects(() => adapter._streamClient.stopAndRotate(turnState.streamIds.qi), /ratelimited/);
  assert.equal(turnState.streamFailed, true);
  assert.equal(turnState.taskCardStates.qi.failed, true);
  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream', 'chat.appendStream', 'chat.stopStream', 'chat.startStream']);
});

test('auto rotate stopStream failure leaves old stream appendable', async () => {
  const calls = [];
  let tsSeq = 0;
  const client = createStreamClient({
    webClient: {
      conversations: {
        async replies() {
          return { messages: [{ user: 'U1' }] };
        },
      },
      async apiCall(method, payload) {
        calls.push([method, payload]);
        if (method === 'chat.startStream') {
          tsSeq += 1;
          return { ok: true, ts: `1777.${tsSeq}` };
        }
        if (method === 'chat.stopStream') {
          throw Object.assign(new Error('stop failed'), { data: { error: 'internal_error' } });
        }
        return { ok: true };
      },
    },
    getTeamId: () => 'T1',
    postReply: async () => ({ ts: '1777.reply' }),
    autoRotateEnabled: () => true,
  });
  const result = await client.startStream('C1', '111.222', {
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
  });

  await assert.rejects(() => client.stopAndRotate(result.stream_id), /internal_error/);
  await client.appendStream(result.stream_id, [{ type: 'markdown_text', text: 'still live' }]);

  assert.deepEqual(calls.map(([method]) => method), [
    'chat.startStream',
    'chat.stopStream',
    'chat.appendStream',
  ]);
  assert.equal(calls.at(-1)[1].ts, '1777.1');
});

test('stopStream old id waiting on rotate deletes the current rotated stream entry', async () => {
  const calls = [];
  let tsSeq = 0;
  let releaseSecondStart;
  const secondStartStarted = new Promise((resolve) => {
    releaseSecondStart = resolve;
  });
  const releaseSecondStartWait = {};
  releaseSecondStartWait.promise = new Promise((resolve) => {
    releaseSecondStartWait.resolve = resolve;
  });
  const client = createStreamClient({
    webClient: {
      conversations: {
        async replies() {
          return { messages: [{ user: 'U1' }] };
        },
      },
      async apiCall(method, payload) {
        calls.push([method, payload]);
        if (method === 'chat.startStream') {
          tsSeq += 1;
          if (tsSeq === 2) {
            releaseSecondStart();
            await releaseSecondStartWait.promise;
          }
          return { ok: true, ts: `1777.${tsSeq}` };
        }
        return { ok: true };
      },
    },
    getTeamId: () => 'T1',
    postReply: async () => ({ ts: '1777.reply' }),
    autoRotateEnabled: () => true,
  });
  const result = await client.startStream('C1', '111.222', {
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
  });

  const rotatePromise = client.stopAndRotate(result.stream_id);
  await secondStartStarted;
  const stopPromise = client.stopStream(result.stream_id, { chunks: [{ type: 'markdown_text', text: 'done' }] });
  releaseSecondStartWait.resolve();
  const rotated = await rotatePromise;
  await stopPromise;
  await assert.rejects(
    () => client.appendStream(rotated.stream_id, [{ type: 'markdown_text', text: 'late' }]),
    /unknown stream id: C1:1777\.2/,
  );

  assert.deepEqual(calls.map(([method]) => method), [
    'chat.startStream',
    'chat.stopStream',
    'chat.startStream',
    'chat.stopStream',
  ]);
  assert.equal(calls[3][1].ts, '1777.2');
});

test('appendStream rejects a stopped stream after rotate start failure without Slack append', async () => {
  const calls = [];
  let tsSeq = 0;
  const rotations = [];
  const client = createStreamClient({
    webClient: {
      conversations: {
        async replies() {
          return { messages: [{ user: 'U1' }] };
        },
      },
      async apiCall(method, payload) {
        calls.push([method, payload]);
        if (method === 'chat.startStream') {
          tsSeq += 1;
          if (tsSeq === 2) return { ok: false, error: 'unavailable' };
          return { ok: true, ts: `1777.${tsSeq}` };
        }
        return { ok: true };
      },
    },
    getTeamId: () => 'T1',
    postReply: async () => ({ ts: '1777.reply' }),
    autoRotateEnabled: () => true,
  });
  const result = await client.startStream('C1', '111.222', {
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
    on_rotate: (rotation) => rotations.push(rotation),
  });

  await assert.rejects(() => client.stopAndRotate(result.stream_id), /unavailable/);
  await assert.rejects(
    () => client.appendStream(result.stream_id, [{ type: 'markdown_text', text: 'late' }]),
    /stream_stopped/,
  );

  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].ok, false);
  assert.equal(rotations[0].stopped, true);
  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream', 'chat.stopStream', 'chat.startStream']);
});

test('rebuildInitialChunks empty falls back to snapshot during rotate', async () => {
  const calls = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    task_display_mode: 'plan',
    initial_chunks: [{ type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: '' }],
    rebuild_initial_chunks: () => [],
  });
  await client.appendStream(result.stream_id, [
    { type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress', details: 'A1\n' },
  ]);

  await client.stopAndRotate(result.stream_id);

  const rotatedStartCall = calls.filter(([method]) => method === 'chat.startStream')[1];
  assert.equal(rotatedStartCall[1].chunks[0].type, 'blocks');
  assert.deepEqual(rotatedStartCall[1].chunks[1], {
    type: 'task_update',
    id: 'qi-exec',
    title: 'Probe',
    status: 'in_progress',
    details: 'A1\n',
  });
});

test('rebuildInitialChunks throw safely fails rotate and notifies callback', async () => {
  const calls = [];
  const rotations = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
    rebuild_initial_chunks: () => {
      throw new Error('rebuild failed');
    },
    on_rotate: (rotation) => rotations.push(rotation),
  });

  await assert.rejects(() => client.stopAndRotate(result.stream_id), /rebuild failed/);
  await assert.rejects(
    () => client.appendStream(result.stream_id, [{ type: 'markdown_text', text: 'late' }]),
    /stream_stopped/,
  );

  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].ok, false);
  assert.match(rotations[0].error.message, /rebuild failed/);
  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream', 'chat.stopStream']);
});

test('stopStream clears pending auto rotate timer', async () => {
  const calls = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
    rotate_after_ms: 15,
  });

  await client.stopStream(result.stream_id, { chunks: [{ type: 'markdown_text', text: 'done' }] });
  await delay(40);

  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream', 'chat.stopStream']);
});

test('stopAndRotate is a no-op after stream has already stopped', async () => {
  const calls = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
  });

  await client.stopStream(result.stream_id, { chunks: [{ type: 'markdown_text', text: 'done' }] });
  assert.equal(await client.stopAndRotate(result.stream_id), undefined);

  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream', 'chat.stopStream']);
});

test('short completed turn does not leave an orphan auto rotate', async () => {
  const calls = [];
  const rotations = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    task_display_mode: 'plan',
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
    on_rotate: (rotation) => rotations.push(rotation),
    rotate_after_ms: 20,
  });

  await client.appendStream(result.stream_id, [{ type: 'markdown_text', text: 'progress' }]);
  await delay(5);
  await client.stopStream(result.stream_id, { chunks: [{ type: 'markdown_text', text: 'done' }] });
  await delay(45);

  assert.deepEqual(rotations, []);
  assert.deepEqual(calls.map(([method]) => method), [
    'chat.startStream',
    'chat.appendStream',
    'chat.stopStream',
  ]);
});

test('auto rotate timer still rotates a live long turn', async () => {
  const calls = [];
  const rotations = [];
  const client = streamClient(calls, { autoRotateEnabled: () => true });
  const result = await client.startStream('C1', '111.222', {
    task_display_mode: 'plan',
    initial_chunks: [{ type: 'plan_update', title: 'Working' }],
    on_rotate: (rotation) => rotations.push(rotation),
    rotate_after_ms: 30,
  });

  await delay(40);

  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].prev_stream_id, result.stream_id);
  assert.equal(rotations[0].stream_id, 'C1:1777.2');
  assert.deepEqual(calls.map(([method]) => method), [
    'chat.startStream',
    'chat.stopStream',
    'chat.startStream',
  ]);
  await client.stopStream(rotations[0].stream_id, { chunks: [{ type: 'markdown_text', text: 'done' }] });
});

test('SlackAdapter auto rotate callback updates turn stream state', async () => {
  const calls = [];
  let tsSeq = 0;
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  adapter._teamId = 'T1';
  adapter._slack = {
    conversations: {
      async replies() {
        return { messages: [{ user: 'U1' }] };
      },
    },
    async apiCall(method, payload) {
      calls.push([method, payload]);
      if (method === 'chat.startStream') {
        tsSeq += 1;
        return { ok: true, ts: `1777.${tsSeq}` };
      }
      return { ok: true };
    },
  };
  const turnState = {
    streamId: null,
    streamIds: {},
    streamMessageTs: null,
    streamMessageTsByChannel: {},
    taskCardStates: {
      qi: { enabled: true, deferred: false, streamId: null, streamMessageTs: null, failed: false },
    },
  };

  const started = await adapter.deliver({
    intent: 'task_progress.start',
    channel: 'C1',
    threadTs: '111.222',
    text: 'Orbiting',
    meta: {
      streamChannel: 'qi',
      task_display_mode: 'plan',
      chunks: [{ type: 'plan_update', title: 'Orbiting...' }],
      teamId: 'T1',
      autoRotate: true,
    },
  }, { channel: 'stream', turnState });
  await adapter._streamClient.stopAndRotate(started.stream_id);

  assert.equal(turnState.streamId, 'C1:1777.2');
  assert.equal(turnState.streamMessageTs, '1777.2');
  assert.equal(turnState.streamIds.qi, 'C1:1777.2');
  assert.equal(turnState.streamMessageTsByChannel.qi, '1777.2');
  assert.equal(turnState.taskCardStates.qi.streamId, 'C1:1777.2');
  assert.deepEqual(calls.map(([method]) => method), ['chat.startStream', 'chat.stopStream', 'chat.startStream']);
});

test('SlackAdapter auto rotate keeps plan and qi streams independent', async () => {
  const calls = [];
  let tsSeq = 0;
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  adapter._teamId = 'T1';
  adapter._slack = {
    conversations: {
      async replies() {
        return { messages: [{ user: 'U1' }] };
      },
    },
    async apiCall(method, payload) {
      calls.push([method, payload]);
      if (method === 'chat.startStream') {
        tsSeq += 1;
        return { ok: true, ts: `1777.${tsSeq}` };
      }
      return { ok: true };
    },
  };
  const turnState = {
    streamId: null,
    streamIds: {},
    streamMessageTs: null,
    streamMessageTsByChannel: {},
    taskCardStates: {
      qi: { enabled: true, deferred: false, streamId: null, streamMessageTs: null, failed: false },
      plan: { enabled: true, deferred: false, streamId: null, streamMessageTs: null, failed: false },
    },
  };

  const planStarted = await adapter.deliver({
    intent: 'task_progress.start',
    channel: 'C1',
    threadTs: '111.222',
    text: 'Plan',
    meta: {
      streamChannel: 'plan',
      task_display_mode: 'plan',
      chunks: [{ type: 'plan_update', title: 'Plan' }],
      teamId: 'T1',
      autoRotate: true,
    },
  }, { channel: 'stream', turnState });
  const qiStarted = await adapter.deliver({
    intent: 'task_progress.start',
    channel: 'C1',
    threadTs: '111.222',
    text: 'Qi',
    meta: {
      streamChannel: 'qi',
      task_display_mode: 'plan',
      chunks: [{ type: 'task_update', id: 'qi-exec', title: 'Probe', status: 'in_progress' }],
      teamId: 'T1',
      autoRotate: true,
    },
  }, { channel: 'stream', turnState });

  const planRotated = await adapter._streamClient.stopAndRotate(planStarted.stream_id);
  const qiRotated = await adapter._streamClient.stopAndRotate(qiStarted.stream_id);

  assert.equal(turnState.streamIds.plan, planRotated.stream_id);
  assert.equal(turnState.streamIds.qi, qiRotated.stream_id);
  assert.equal(turnState.streamMessageTsByChannel.plan, planRotated.ts);
  assert.equal(turnState.streamMessageTsByChannel.qi, qiRotated.ts);
  assert.equal(turnState.taskCardStates.plan.streamId, planRotated.stream_id);
  assert.equal(turnState.taskCardStates.qi.streamId, qiRotated.stream_id);
  assert.equal(turnState.streamId, qiRotated.stream_id);
  assert.notEqual(turnState.streamIds.plan, turnState.streamIds.qi);
  assert.deepEqual(calls.map(([method]) => method), [
    'chat.startStream',
    'chat.startStream',
    'chat.stopStream',
    'chat.startStream',
    'chat.stopStream',
    'chat.startStream',
  ]);
});

test('setTyping and setThreadStatus call assistant status API', async () => {
  const calls = [];
  const client = streamClient(calls);
  await client.setTyping('C1', '111.222', true);
  await client.setThreadStatus('C1', '111.222', 'thinking', ['one']);
  assert.equal(calls[0][0], 'assistant.threads.setStatus');
  assert.equal(calls[0][1].status, 'true');
  assert.deepEqual(calls[1][1].loading_messages, ['one']);
});

test('SlackAdapter exposes PlatformAdapter methods and delegates typing status', async () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  const required = ['start', 'disconnect', 'sendReply', 'editMessage', 'uploadFile', 'setTyping', 'sendApproval', 'buildPayloads', 'fetchThreadHistory', 'installCcEventSubscriber'];
  for (const name of required) assert.equal(typeof adapter[name], 'function', name);

  const calls = [];
  adapter._slack = {
    async apiCall(method, payload) {
      calls.push([method, payload]);
      return { ok: true };
    },
  };
  await adapter.setTyping('C1', '111.222', true);
  await adapter.setThreadStatus('C1', '111.222', 'working');
  assert.deepEqual(calls.map(([method]) => method), ['assistant.threads.setStatus', 'assistant.threads.setStatus']);
});

test('SlackAdapter silently exits lost-ownership fallback when final blocks are empty', async () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  const replies = [];
  adapter.stopStream = async () => {
    throw Object.assign(new Error('chat.stopStream failed: message_not_in_streaming_state'), {
      slackErrorCode: 'message_not_in_streaming_state',
    });
  };
  adapter.sendReply = async (channel, threadTs, text, extra = {}) => {
    replies.push({ channel, threadTs, text, extra });
    return { ts: `reply-${replies.length}` };
  };

  assert.deepEqual(adapter.buildPayloads('', { dailyNotesSummary: { count: 1 } }), [{ text: '(无回复)' }]);

  const result = await adapter.deliver({
    intent: 'assistant_text.final',
    channel: 'C1',
    threadTs: '111.222',
    text: 'done',
    meta: { dailyNotesSummary: { count: 1 } },
  }, {
    channel: 'stream',
    turnState: { streamId: 'stream-1', streamMessageTs: '111.333', assistantStreamTextLen: 4 },
  });

  assert.deepEqual(result, { streamId: 'stream-1', ts: '111.333' });
  assert.equal(replies.length, 0);
});

test('SlackAdapter builds AskUserQuestion single and multi question blocks', async () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  const longQuestion = 'Which format should be used for this answer when the prompt text is intentionally long enough to exceed the old Slack option value limit?';
  const single = adapter._buildAskUserQuestionBlocks({
    requestId: 'req1',
    socketPath: '/tmp/orb.sock',
    questions: [{
      header: 'Format choice',
      question: longQuestion,
      options: [{ label: 'Bullets' }, { label: 'Table' }],
    }],
  });
  assert.equal(single[0].type, 'header');
  assert.equal(single.at(-1).elements[0].action_id, 'orb_auq_pick_0_0');
  assert.deepEqual(JSON.parse(single.at(-1).elements[0].value), { requestId: 'req1', qIdx: 0, optIdx: 0 });
  assert.equal(single.at(-1).elements.at(-1).action_id, 'orb_auq_pick_0_other');
  assert.deepEqual(JSON.parse(single.at(-1).elements.at(-1).value), { requestId: 'req1', qIdx: 0, optIdx: 'other' });

  const multi = adapter._buildAskUserQuestionBlocks({
    requestId: 'req2',
    socketPath: '/tmp/orb.sock',
    questions: [
      { header: 'One', question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
      { header: 'Two', question: 'Q2', multiSelect: true, options: [{ label: 'C' }, { label: 'D' }] },
    ],
  });
  assert.equal(multi.find((block) => block.block_id === 'orb_auq_req2_select_0').elements[0].type, 'radio_buttons');
  assert.equal(multi.find((block) => block.block_id === 'orb_auq_req2_select_1').elements[0].type, 'checkboxes');
  assert.deepEqual(
    JSON.parse(multi.find((block) => block.block_id === 'orb_auq_req2_select_0').elements[0].options.at(-1).value),
    { requestId: 'req2', qIdx: 0, optIdx: 'other' },
  );
  assert.equal(multi.at(-1).elements[0].action_id, 'orb_auq_submit');

  const optionValues = [...single, ...multi].flatMap((block) => {
    if (block.type !== 'actions') return [];
    return block.elements.flatMap((element) => {
      if (Array.isArray(element.options)) return element.options.map((option) => option.value);
      return element.value ? [element.value] : [];
    });
  });
  assert.ok(optionValues.length > 0);
  for (const value of optionValues) {
    assert.ok(value.length <= 80, `${value} length=${value.length}`);
  }
});

test('SlackAdapter AskUserQuestion long prompt payload stays Slack-safe before postMessage', async () => {
  const calls = [];
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  adapter._slack = {
    chat: {
      async postMessage(payload) {
        calls.push(payload);
        return { ts: '1777.1' };
      },
    },
  };

  await adapter.sendAskUserQuestion({
    channel: 'C1',
    threadTs: '111.222',
    requestId: 'req-long',
    socketPath: '/tmp/orb.sock',
    questions: [{
      header: 'Long prompt',
      question: 'Please choose one option for this intentionally long prompt text that used to make Slack reject option values because serialized metadata exceeded one hundred and fifty characters.',
      options: [{ label: 'Use bullets' }, { label: 'Use a table' }],
    }],
  });

  const values = calls[0].blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements.flatMap((element) => element.value ? [element.value] : []));
  assert.deepEqual(calls.map((payload) => payload.channel), ['C1']);
  assert.ok(values.every((value) => value.length <= 80));
});
