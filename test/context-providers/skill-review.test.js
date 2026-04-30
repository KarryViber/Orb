import test from 'node:test';
import assert from 'node:assert/strict';
import { priorConversationToFragments } from '../../src/context-providers/skill-review.js';

test('skill-review provider emits prior conversation only in skill-review mode', () => {
  const fragments = priorConversationToFragments([
    { role: 'user', content: 'Please review this turn.' },
    { role: 'assistant', content: 'Reviewed.' },
  ], 'skill-review-1', '2026-05-01T00:00:00.000Z', 'skill-review');

  assert.equal(fragments.length, 2);
  assert.equal(fragments[0].source_type, 'skill_review_conversation');
  assert.equal(fragments[0].trusted, 'mixed');
  assert.equal(fragments[1].trusted, true);
  assert.deepEqual(
    priorConversationToFragments([{ role: 'user', content: 'skip' }], 't1', 'now', 'default'),
    [],
  );
});
