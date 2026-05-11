import test from 'node:test';
import assert from 'node:assert/strict';
import { fileContentToFragments, legacyAttachmentProvider } from '../../src/context-providers/legacy-attachment.js';

const retrievedAt = '2026-05-05T00:00:00.000Z';

test('fileContentToFragments returns empty list for missing content', () => {
  assert.deepEqual(fileContentToFragments({ fileContent: '', retrievedAt }), []);
});

test('fileContentToFragments preserves legacy attachment labels', () => {
  assert.deepEqual(fileContentToFragments({ fileContent: 'attachment body', retrievedAt }), [{
    source_type: 'attachment',
    trusted: 'semi',
    origin: 'legacy:fileContent',
    content: 'attachment body',
    retrieved_at: retrievedAt,
  }]);
});

test('legacyAttachmentProvider returns attachment fragments', async () => {
  const [fragment] = await legacyAttachmentProvider.prefetch({ fileContent: 'x', retrievedAt });
  assert.equal(fragment.content, 'x');
  assert.equal(fragment.trusted, 'semi');
});
