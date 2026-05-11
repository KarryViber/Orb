import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createThreadContextHelper,
  extractBlockKitText,
  extractSlackThreadUrls,
} from '../../../src/adapters/slack/thread-context.js';

function webClient(overrides = {}) {
  return {
    conversations: {
      async replies() {
        return { messages: [] };
      },
      async info() {
        return { channel: { topic: { value: '' }, purpose: { value: '' } } };
      },
      ...overrides.conversations,
    },
    users: {
      async info({ user }) {
        return { user: { profile: { display_name: `name-${user}` } } };
      },
      ...overrides.users,
    },
  };
}

test('extractSlackThreadUrls prefers thread_ts query over message timestamp', () => {
  const urls = extractSlackThreadUrls('see https://orb.slack.com/archives/C123/p1777000000000001?thread_ts=1777.000002&cid=C123');
  assert.deepEqual(urls, [{ channel: 'C123', threadTs: '1777.000002', messageTs: '1777000000.000001' }]);
});

test('extractBlockKitText reads headers, sections, fields, and context', () => {
  const text = extractBlockKitText([
    { type: 'header', text: { text: 'Title' } },
    { type: 'section', text: { text: 'Body' }, fields: [{ text: 'Field' }] },
    { type: 'context', elements: [{ text: 'Meta' }] },
  ]);
  assert.equal(text, 'Title\nBody\nField\nMeta');
});

test('extractBlockKitText skips runtime receipt context lines', () => {
  const text = extractBlockKitText([
    { type: 'context', elements: [{ text: '📓 12:46｜[配置层]｜daemon 重启 + 验真 落地\n🪞 12:47｜karry｜自我校准\nkeep me' }] },
    { type: 'context', elements: [{ text: '> _📝 改动 · 1 files (+2 -0)_\n> • `M` src/worker.js (+2 -0)' }] },
  ]);

  assert.equal(text, 'keep me');
});

test('fetchThreadHistory formats messages and uses cache', async () => {
  let calls = 0;
  const helper = createThreadContextHelper({
    webClient: webClient({
      conversations: {
        async replies() {
          calls += 1;
          return {
            messages: [
              { user: 'U1', text: 'hello', ts: '1' },
              { bot_id: 'B2', blocks: [{ type: 'section', text: { text: '[phase:plan] done' } }], ts: '2' },
              { user: 'U1', text: 'latest', ts: '3' },
            ],
          };
        },
      },
    }),
    botToken: 'xoxb-test',
    imageCacheDir: '/tmp/orb-test-cache',
  });

  const first = await helper.fetchThreadHistory('111.222', 'C1');
  const second = await helper.fetchThreadHistory('111.222', 'C1');
  assert.match(first, /name-U1: hello/);
  assert.match(first, /Orb: \[phase:plan\] done/);
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('fetchChannelMeta returns empty metadata when Slack lookup fails', async () => {
  const helper = createThreadContextHelper({
    webClient: webClient({
      conversations: {
        async info() {
          throw new Error('no access');
        },
      },
    }),
    botToken: 'xoxb-test',
    imageCacheDir: '/tmp/orb-test-cache',
  });
  assert.deepEqual(await helper.fetchChannelMeta('C1'), { topic: '', purpose: '' });
});
