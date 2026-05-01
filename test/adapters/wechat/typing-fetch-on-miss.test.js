import test from 'node:test';
import assert from 'node:assert/strict';
import { WeChatAdapter } from '../../../src/adapters/wechat.js';

test('WeChat setTyping fetches a typing ticket on cache miss and times out quickly', async () => {
  const adapter = new WeChatAdapter({ accountId: 'acct', token: 'token', baseUrl: 'https://wechat.test' });
  let fetchCalls = 0;
  adapter._fetchTypingTicket = async () => {
    fetchCalls += 1;
    return new Promise(() => {});
  };

  const startedAt = Date.now();
  await adapter.setTyping('user-timeout', null, true);
  const elapsed = Date.now() - startedAt;

  assert.equal(fetchCalls, 1);
  assert.equal(elapsed < 800, true, `setTyping should not block on a hung ticket fetch; elapsed=${elapsed}`);
});

test('WeChat setTyping sends typing API after fetching a ticket', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    const payload = url.endsWith('/ilink/bot/getconfig')
      ? { typing_ticket: 'ticket-123' }
      : { ret: 0, errcode: 0 };
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  try {
    const adapter = new WeChatAdapter({ accountId: 'acct', token: 'token', baseUrl: 'https://wechat.test' });
    adapter._tokenStore = { get: () => 'ctx-123' };

    await adapter.setTyping('user-success', null, true);

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://wechat.test/ilink/bot/getconfig');
    assert.equal(requests[0].body.ilink_user_id, 'user-success');
    assert.equal(requests[0].body.context_token, 'ctx-123');
    assert.equal(requests[1].url, 'https://wechat.test/ilink/bot/sendtyping');
    assert.equal(requests[1].body.ilink_user_id, 'user-success');
    assert.equal(requests[1].body.typing_ticket, 'ticket-123');
    assert.equal(requests[1].body.status, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WeChat typing ticket fetches are deduplicated while in flight', async () => {
  const originalFetch = globalThis.fetch;
  let getConfigCalls = 0;
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  globalThis.fetch = async (url) => {
    if (url.endsWith('/ilink/bot/getconfig')) {
      getConfigCalls += 1;
      return fetchPromise;
    }
    return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
  };

  try {
    const adapter = new WeChatAdapter({ accountId: 'acct', token: 'token', baseUrl: 'https://wechat.test' });
    const first = adapter._fetchTypingTicket('user-dedupe', 'ctx');
    const second = adapter._fetchTypingTicket('user-dedupe', 'ctx');
    assert.equal(getConfigCalls, 1);
    resolveFetch(new Response(JSON.stringify({ typing_ticket: 'ticket-dedupe' }), { status: 200 }));
    assert.equal(await first, 'ticket-dedupe');
    assert.equal(await second, 'ticket-dedupe');
    assert.equal(getConfigCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
