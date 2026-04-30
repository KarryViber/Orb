import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SlackAdapter,
} from '../src/adapters/slack.js';
import {
  EventBus,
} from '../src/scheduler.js';
import { createTurnDeliveryCcEventSubscriber } from '../src/turn-delivery/cc-event-subscriber.js';
import { TurnDeliveryOrchestrator } from '../src/turn-delivery/orchestrator.js';

function toolUse(turnId, name, input = {}) {
  return { type: 'cc_event', turnId, eventType: 'tool_use', payload: { type: 'tool_use', id: `${turnId}-${name}`, name, input } };
}

function result(turnId) {
  return { type: 'cc_event', turnId, eventType: 'result', payload: { stop_reason: 'end_turn' } };
}

function createStreamingAdapter() {
  const calls = [];
  let seq = 0;
  return {
    calls,
    async startStream(channel, threadTs, options) {
      seq += 1;
      const stream = { stream_id: `stream-${seq}`, ts: `${seq}.000` };
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
  };
}

function attachOrchestrator(adapter, ctx) {
  ctx.orchestrator = new TurnDeliveryOrchestrator({ adapter });
  ctx.task = { ...(ctx.task || {}), attemptId: 'attempt-1' };
}

test('turn_complete duplicate delivery posts only once', async () => {
  const calls = [];
  const adapter = {
    capabilities: { stream: false },
    async deliver(intent, { channel }) {
      if (channel === 'postMessage') calls.push(['sendReply', intent.channel, intent.threadTs, intent.text]);
      return { ts: '1.000' };
    },
  };
  const orchestrator = new TurnDeliveryOrchestrator({ adapter });
  orchestrator.beginTurn({ turnId: 'turn-dedupe', attemptId: 'attempt-1', channel: 'C1', threadTs: '111.222', platform: 'slack' });

  await orchestrator.emit({ turnId: 'turn-dedupe', attemptId: 'attempt-1', channel: 'C1', threadTs: '111.222', platform: 'slack', intent: 'assistant_text.final', text: 'done', source: 'test' });
  const second = await orchestrator.emit({ turnId: 'turn-dedupe', attemptId: 'attempt-1', channel: 'C1', threadTs: '111.222', platform: 'slack', intent: 'assistant_text.final', text: 'done', source: 'test' });

  assert.equal(calls.length, 1);
  assert.equal(second.reason, 'already-delivered');
});

test('Qi stopStream settles existing chunks without repeating append details', async () => {
  const adapter = createStreamingAdapter();
  const bus = new EventBus();
  bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 10, statusHeartbeatMs: 10_000 }));
  const ctx = { channel: 'C1', threadTs: '111.222', effectiveThreadTs: '111.222', task: { teamId: 'T1' } };
  attachOrchestrator(adapter, ctx);

  await bus.publish(toolUse('turn-q', 'Bash', { description: 'one' }), ctx);
  await bus.publish(toolUse('turn-q', 'WebSearch', { query: 'two' }), ctx);
  await bus.publish(toolUse('turn-q', 'Task', { description: 'three' }), ctx);
  await bus.publish(result('turn-q'), ctx);

  const appendedDetails = adapter.calls
    .filter((call) => call[0] === 'appendStream')
    .flatMap(([, , chunks]) => chunks)
    .map((chunk) => chunk.details || '')
    .join('');
  const stopDetails = adapter.calls
    .filter((call) => call[0] === 'stopStream')
    .flatMap(([, , payload]) => payload.chunks || [])
    .map((chunk) => chunk.details || '')
    .join('');

  assert.equal((appendedDetails.match(/Bash: one/g) || []).length, 1);
  assert.equal((appendedDetails.match(/WebSearch: two/g) || []).length, 1);
  assert.equal((appendedDetails.match(/Task: three/g) || []).length, 1);
  assert.equal(stopDetails.includes('Bash: one'), false);
  assert.equal(stopDetails.includes('WebSearch: two'), false);
  assert.equal(stopDetails.includes('Task: three'), false);
});

test('status bubble clears on turn_abort after tool_use', async () => {
  const bus = new EventBus();
  bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 10, statusHeartbeatMs: 10_000 }));
  const statuses = [];
  const ctx = { async applyThreadStatus(status) { statuses.push(status); } };

  await bus.publish(toolUse('turn-status-abort', 'Bash', { description: 'long run' }), ctx);
  await bus.publish({ type: 'cc_event', turnId: 'turn-status-abort', eventType: 'turn_abort', synthetic: true }, ctx);

  assert.equal(statuses[0], 'Bash: long run');
  assert.equal(statuses.at(-1), '');
});

test('new turns allocate distinct Slack streams', async () => {
  const adapter = createStreamingAdapter();
  const bus = new EventBus();
  bus.subscribe(createTurnDeliveryCcEventSubscriber({ textDebounceMs: 10, statusHeartbeatMs: 10_000 }));
  const ctx = { channel: 'C1', threadTs: '111.222', effectiveThreadTs: '111.222', task: { teamId: 'T1' } };
  attachOrchestrator(adapter, ctx);

  await bus.publish(toolUse('turn-a', 'Bash', { description: 'first turn' }), ctx);
  await bus.publish(result('turn-a'), ctx);
  await bus.publish(toolUse('turn-b', 'Bash', { description: 'second turn' }), ctx);
  await bus.publish(result('turn-b'), ctx);

  const streamIds = adapter.calls
    .filter((call) => call[0] === 'startStream')
    .map((call) => call[4].stream_id);
  const stopped = adapter.calls
    .filter((call) => call[0] === 'stopStream')
    .map((call) => call[1]);

  assert.deepEqual(streamIds, ['stream-1', 'stream-2']);
  assert.deepEqual(stopped, ['stream-1', 'stream-2']);
});

test('stream markdown_text chunks convert markdown emphasis to Slack mrkdwn', () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });

  assert.deepEqual(
    adapter.normalizeStreamChunks([{ type: 'markdown_text', text: '**bold**' }]),
    [{ type: 'markdown_text', text: '*bold*' }],
  );
});

test('stream text chunks convert mixed markdown with CJK boundaries to Slack mrkdwn', () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });

  assert.deepEqual(
    adapter.normalizeStreamChunks([{ type: 'text', text: '这里**重点**词 + *italic*' }]),
    [{ type: 'markdown_text', text: '这里\u200b*重点*\u200b词 + _italic_' }],
  );
});

test('stream non-text chunk paths keep existing normalization behavior', () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '**raw**' } }];

  assert.deepEqual(
    adapter.normalizeStreamChunks([
      { type: 'task_update', id: 'task-1', title: '**raw**', status: 'completed', details: '**details**' },
      { type: 'plan_update', title: '**plan**' },
      { type: 'blocks', blocks },
    ]),
    [
      { type: 'task_update', id: 'task-1', title: '**raw**', status: 'complete', details: '**details**' },
      { type: 'plan_update', title: '**plan**' },
      { type: 'blocks', blocks },
    ],
  );
});

test('stopStream finalText converts **bold** before send', async () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  const calls = [];
  adapter._slack = {
    async apiCall(method, payload) {
      calls.push([method, payload]);
      return { ok: true };
    },
  };
  adapter._streams.set('stream-1', {
    channel: 'C1',
    ts: '111.222',
    startedAt: Date.now(),
  });

  await adapter.stopStream('stream-1', {
    markdown_text: '**Tesla App 远程关哨兵**（最新版仍保留）',
  });

  assert.equal(calls[0][0], 'chat.stopStream');
  assert.equal(calls[0][1].markdown_text, '*Tesla App 远程关哨兵*\u200b（最新版仍保留）');
});

test('cleanupIndicator wraps errorMsg with markdownToMrkdwn', async () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  const replies = [];
  adapter._postReply = async (channel, threadTs, text) => {
    replies.push({ channel, threadTs, text });
  };

  await adapter.cleanupIndicator('C1', '111.222', false, '**boom**');

  assert.deepEqual(replies, [
    { channel: 'C1', threadTs: '111.222', text: ':warning: *boom*' },
  ]);
});

test('DM routing mainText converts mainTemplate placeholders', async () => {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    dmRouting: {
      enabled: true,
      rules: [{
        name: 'repo',
        match: { urlPattern: 'https://github\\.com/[^\\s]+' },
        target: {
          channel: 'C-target',
          mainTemplate: '卡片：**{repo_slug}**',
          workerPrompt: 'worker {repo_slug}',
        },
      }],
    },
  });
  const posts = [];
  adapter._slack = {
    chat: {
      async postMessage(payload) {
        posts.push(payload);
        return { ok: true, ts: '222.333' };
      },
    },
  };

  const result = await adapter._routeDMMessage({
    text: 'see https://github.com/acme/orb',
    files: [],
    user: 'U1',
    ts: '111.222',
  });

  assert.deepEqual(result, { routed: true });
  assert.equal(posts[0].text, '卡片：\u200b*acme/orb*');
});

test('DM routing sends original text and URL as labeled fragments', async () => {
  const routedTasks = [];
  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    dmRouting: {
      enabled: true,
      rules: [{
        name: 'repo',
        match: { urlPattern: 'https://github\\.com/[^\\s]+' },
        target: {
          channel: 'C-target',
          mainTemplate: '卡片：{repo_slug}',
          workerPrompt: 'worker {url_matched} {original_text} {repo_slug}',
        },
      }],
    },
  });
  adapter.onMessage = (task) => routedTasks.push(task);
  adapter._slack = {
    chat: {
      async postMessage(payload) {
        return { ok: true, ts: '222.333', payload };
      },
    },
  };

  await adapter._routeDMMessage({
    text: 'please inspect https://github.com/acme/orb',
    files: [],
    user: 'U1',
    ts: '111.222',
  });

  assert.equal(routedTasks.length, 1);
  assert.doesNotMatch(routedTasks[0].userText, /please inspect/);
  assert.doesNotMatch(routedTasks[0].userText, /https:\/\/github.com\/acme\/orb/);
  assert.match(routedTasks[0].userText, /\[routed_dm_payload:url_matched\]/);
  assert.match(routedTasks[0].userText, /\[routed_dm_payload:original_text\]/);
  assert.deepEqual(routedTasks[0].fragments.map((fragment) => fragment.source_type), [
    'routed_dm_payload',
    'routed_dm_payload',
  ]);
  assert.equal(routedTasks[0].fragments.find((fragment) => fragment.metadata.key === 'url_matched').trusted, false);
});

test('thread history keeps emoji-prefixed bot messages when blocks contain content', async () => {
  const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test' });
  adapter._slack = {
    conversations: {
      async replies() {
        return {
          messages: [
            {
              bot_id: 'B1',
              text: ':bar_chart: 持仓日检',
              blocks: [
                { type: 'header', text: { type: 'plain_text', text: ':bar_chart: 持仓日检' } },
                { type: 'section', text: { type: 'mrkdwn', text: '*建议*\n执行减仓并记录原因' } },
              ],
            },
            { bot_id: 'B1', text: ':white_check_mark:' },
            { user: 'U1', text: '执行下建议的操作' },
          ],
        };
      },
    },
  };
  adapter._resolveUserName = async () => 'Karry';

  const history = await adapter.fetchThreadHistory('111.222', 'C1', { bypassCache: true });

  assert.match(history, /Orb: :bar_chart: 持仓日检\n\*建议\*\n执行减仓并记录原因/);
  assert.doesNotMatch(history, /white_check_mark/);
  assert.doesNotMatch(history, /执行下建议的操作/);
});

test('isHeadingLine rejects line with inline bold + colon end', async () => {
  const { buildSendPayloads } = await import('../src/adapters/slack-format.js');
  const text = '下面这段是给你目视验证的，**故意紧贴中文+全角括号**触发原 bug pattern：\n\n正文';
  const payloads = buildSendPayloads(text);
  const firstBlockText = payloads[0].blocks[0].text.text;

  assert.match(firstBlockText, /\*故意紧贴中文\+全角括号\*/);
  assert.doesNotMatch(firstBlockText, /^\*下面这段/);
});

test('isHeadingLine still accepts pure bold-only title', async () => {
  const { buildSendPayloads } = await import('../src/adapters/slack-format.js');
  const text = '**纯标题**\n\n正文';
  const payloads = buildSendPayloads(text);

  assert.equal(payloads[0].blocks[0].text.text, '*纯标题*');
});

test('isHeadingLine still accepts plain colon-end title without emphasis', async () => {
  const { buildSendPayloads } = await import('../src/adapters/slack-format.js');
  const text = '今日待办：\n\n正文';
  const payloads = buildSendPayloads(text);

  assert.equal(payloads[0].blocks[0].text.text, '*今日待办*');
});
