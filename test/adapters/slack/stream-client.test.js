import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamClient } from '../../../src/adapters/slack/stream-client.js';
import { SlackAdapter } from '../../../src/adapters/slack.js';

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
  assert.equal(calls[3][1].ts, undefined);
  assert.equal(calls[3][1].chunks[0].type, 'blocks');
  assert.equal(calls[3][1].chunks[0].blocks[0].elements[0].text, '↩️ 续');
  assert.equal(calls[4][1].ts, '1777.2');
  assert.deepEqual(rotations.map((rotation) => rotation.reason), ['auto-rotate']);
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

test('SlackAdapter falls back to context-only postMessage when final stopStream lost ownership', async () => {
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

  assert.equal(result.ts, 'reply-1');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, '📓');
  assert.equal(replies[0].extra.blocks[0].elements[0].text, '📓 _日记已追加_');
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
