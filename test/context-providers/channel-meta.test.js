import test from 'node:test';
import assert from 'node:assert/strict';
import { channelMetaProvider, channelMetaToFragments } from '../../src/context-providers/channel-meta.js';

const retrievedAt = '2026-05-05T00:00:00.000Z';

test('channelMetaToFragments returns empty list for empty input', () => {
  assert.deepEqual(channelMetaToFragments({ channelMeta: null, channel: 'C1', retrievedAt }), []);
});

test('channelMetaToFragments preserves topic and purpose as untrusted Slack metadata', () => {
  const [fragment] = channelMetaToFragments({
    channelMeta: { topic: 'builds', purpose: 'alerts' },
    channel: 'C1',
    retrievedAt,
  });
  assert.equal(fragment.source_type, 'slack_channel_meta');
  assert.equal(fragment.trusted, false);
  assert.equal(fragment.origin, 'slack:channel:C1');
  assert.equal(fragment.platform, 'slack');
  assert.equal(fragment.retrieved_at, retrievedAt);
  assert.deepEqual(JSON.parse(fragment.content), { topic: 'builds', purpose: 'alerts' });
});

test('channelMetaProvider uses unknown channel fallback', async () => {
  const [fragment] = await channelMetaProvider.prefetch({
    channelMeta: { topic: 'topic only' },
    channel: '',
    retrievedAt,
  });
  assert.equal(fragment.origin, 'slack:channel:unknown');
  assert.equal(fragment.channel, '');
});
