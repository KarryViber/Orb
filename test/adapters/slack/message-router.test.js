import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageRouter } from '../../../src/adapters/slack/message-router.js';

function makeRouter({ dmRouting = null, onMessage = () => {}, onReaction = () => {}, replies, ignoredChannels = new Set() } = {}) {
  const posts = [];
  const threadContext = {
    _isDuplicate: () => false,
    _isTrackedThread: () => false,
    _trackThread: () => {},
    _isAssistantThreadRoot: async () => false,
    fetchChannelMeta: async () => ({ topic: '', purpose: '' }),
    _processIncomingFiles: async () => ({ text: '', imagePaths: [], fragments: [] }),
    fetchThreadHistory: async () => 'history',
    _downloadDMFile: async () => '/tmp/file.pdf',
  };
  const router = createMessageRouter({
    webClient: {
      chat: {
        async postMessage(payload) {
          posts.push(payload);
          return { ts: '1777.1' };
        },
      },
      conversations: {
        async replies(payload) {
          return replies ? replies(payload) : { messages: [] };
        },
      },
    },
    allowBots: 'none',
    ignoredChannels,
    freeResponseChannels: new Set(),
    freeResponseUsers: new Set(),
    dmRouting,
    resolveLedger: () => null,
    threadContext,
    approvalController: { _handleMessageChanged: () => {} },
    getBotUserId: () => 'UBOT',
    getBotId: () => 'BBOT',
    getTeamId: () => 'T1',
    getOnMessage: () => onMessage,
    getOnReaction: () => onReaction,
  });
  return { router, posts };
}

test('message router ignores configured ignored channel messages', async () => {
  let called = false;
  const { router } = makeRouter({ ignoredChannels: new Set(['C1']), onMessage: () => { called = true; } });
  await router._handleMessage({ event: { channel: 'C1', user: 'U1', text: 'hello', ts: '1' }, ack: async () => {} });
  assert.equal(called, false);
});

test('message router strips bot mention and emits task', async () => {
  let task = null;
  const { router } = makeRouter({ onMessage: (value) => { task = value; } });
  await router._handleMessage({ event: { channel: 'C1', user: 'U1', text: '<@UBOT> hello', ts: '1' }, ack: async () => {} });
  assert.equal(task.userText, 'hello');
  assert.equal(task.channel, 'C1');
});

test('DM routing posts target card and emits silent task', async () => {
  let task = null;
  const dmRouting = {
    enabled: true,
    rules: [{
      name: 'github',
      match: { urlPattern: 'https://github\\.com/[^\\s]+' },
      target: {
        channel: 'C2',
        mainTemplate: 'repo {{url_matched}}',
        workerPromptTemplate: 'handle [routed_dm_payload:url_matched]',
      },
    }],
  };
  const { router, posts } = makeRouter({ dmRouting, onMessage: (value) => { task = value; } });
  await router._handleMessage({
    event: { channel: 'D1', channel_type: 'im', user: 'U1', text: 'https://github.com/acme/orb', ts: '1' },
    ack: async () => {},
  });
  assert.equal(posts[0].channel, 'C2');
  assert.equal(task.channelSemantics, 'silent');
  assert.equal(task.threadTs, '1777.1');
});

test('fire reaction reruns nearest preceding user message', async () => {
  let rerun = null;
  const { router } = makeRouter({
    onReaction: (value) => { rerun = value; },
    replies: async ({ ts, limit }) => {
      if (limit === 1) return { messages: [{ ts, thread_ts: '111.222', bot_id: 'BBOT' }] };
      return { messages: [
        { ts: '111.222', user: 'U1', text: 'original' },
        { ts: '1777.1', bot_id: 'BBOT', text: 'answer' },
      ] };
    },
  });
  router._trackBotReply('1777.1');
  await router._handleReaction({
    event: { reaction: 'fire', item: { type: 'message', channel: 'C1', ts: '1777.1' } },
    ack: async () => {},
  });
  assert.equal(rerun.userText, '[effort:xhigh] original');
  assert.equal(rerun.threadTs, '111.222');
});
