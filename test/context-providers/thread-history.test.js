import test from 'node:test';
import assert from 'node:assert/strict';
import { threadHistoryToFragments } from '../../src/context-providers/thread-history.js';

test('thread-history provider emits a mixed-trust thread history fragment', () => {
  const [fragment] = threadHistoryToFragments(
    'Karry: please refactor context',
    'C123',
    '111.222',
    '2026-05-01T00:00:00.000Z',
  );

  assert.equal(fragment.source_type, 'thread_history');
  assert.equal(fragment.trusted, 'mixed');
  assert.equal(fragment.origin, 'slack:C123/111.222');
  assert.equal(fragment.platform, 'slack');
  assert.equal(fragment.content, 'Karry: please refactor context');
});
