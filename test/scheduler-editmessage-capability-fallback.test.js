import test from 'node:test';
import assert from 'node:assert/strict';
import { emitPayloadWithCapabilityFallback } from '../src/scheduler.js';

test('emit payload falls back to sendReply when adapter has no editMessage capability', async () => {
  const calls = [];
  const adapter = {
    platform: 'wechat',
    async sendReply(...args) {
      calls.push(['sendReply', ...args]);
    },
  };

  const pendingEdit = await emitPayloadWithCapabilityFallback({
    adapter,
    channel: 'user-1',
    effectiveThreadTs: 'thread-1',
    payload: { text: 'fallback text' },
    pendingEdit: '123.456',
    platform: 'wechat',
  });

  assert.equal(pendingEdit, null);
  assert.deepEqual(calls, [
    ['sendReply', 'user-1', 'thread-1', 'fallback text', {}],
  ]);
});

test('emit payload ignores no-op editMessage on non-Slack adapters and clears pending edit', async () => {
  const calls = [];
  const adapter = {
    platform: 'wechat',
    async editMessage(...args) {
      calls.push(['editMessage', ...args]);
    },
    async sendReply(...args) {
      calls.push(['sendReply', ...args]);
    },
  };

  const pendingEdit = await emitPayloadWithCapabilityFallback({
    adapter,
    channel: 'user-1',
    effectiveThreadTs: 'thread-1',
    payload: { text: 'fallback text', blocks: [{ type: 'section' }] },
    pendingEdit: '123.456',
    platform: 'wechat',
  });

  assert.equal(pendingEdit, null);
  assert.deepEqual(calls, [
    ['sendReply', 'user-1', 'thread-1', 'fallback text', { blocks: [{ type: 'section' }] }],
  ]);
});

test('emit payload uses editMessage for Slack pending edits', async () => {
  const calls = [];
  const adapter = {
    platform: 'slack',
    async editMessage(...args) {
      calls.push(['editMessage', ...args]);
    },
    async sendReply(...args) {
      calls.push(['sendReply', ...args]);
    },
  };

  const pendingEdit = await emitPayloadWithCapabilityFallback({
    adapter,
    channel: 'C1',
    effectiveThreadTs: '111.222',
    payload: { text: 'edited text' },
    pendingEdit: '123.456',
    platform: 'slack',
  });

  assert.equal(pendingEdit, null);
  assert.deepEqual(calls, [
    ['editMessage', 'C1', '123.456', 'edited text', {}],
  ]);
});
