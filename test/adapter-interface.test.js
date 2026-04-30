import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformAdapter } from '../src/adapters/interface.js';

test('PlatformAdapter optional capabilities default to no-op or null', async () => {
  const adapter = new PlatformAdapter();

  assert.equal(await adapter.setSuggestedPrompts('C1', '111.222', []), undefined);
  assert.equal(await adapter.startStream('C1', '111.222', {}), null);
  assert.equal(await adapter.appendStream('stream-1', []), undefined);
  assert.equal(await adapter.stopStream('stream-1', {}), undefined);
  assert.equal(adapter.clearStatusByContext({ channel: 'C1', threadTs: '111.222' }), undefined);
  assert.deepEqual(adapter.capabilities, { stream: false, edit: false, metadata: false });
});

test('PlatformAdapter required methods still throw', async () => {
  const adapter = new PlatformAdapter();

  await assert.rejects(() => adapter.sendReply('C1', '111.222', 'hello'), /not implemented/);
  await assert.rejects(() => adapter.deliver({ intent: 'assistant_text.final' }, {}), /not implemented/);
  await assert.rejects(() => adapter.sendApproval('C1', '111.222', 'approve?'), /not implemented/);
  assert.throws(() => adapter.buildPayloads('hello'), /not implemented/);
  await assert.rejects(() => adapter.cleanupIndicator('C1', '111.222', false, null), /not implemented/);
  assert.throws(() => adapter.botUserId, /not implemented/);
});
