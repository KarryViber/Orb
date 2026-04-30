import test from 'node:test';
import assert from 'node:assert/strict';
import { memoriesToFragments } from '../../src/context-providers/holographic.js';

test('holographic provider maps memories to labeled fragments with manifest items', () => {
  const [fragment] = memoriesToFragments([{
    id: 'm1',
    category: 'lesson',
    source_kind: 'inferred',
    content: 'Prefer provider-based prompt context.',
    trust_score: 0.83,
  }], '2026-05-01T00:00:00.000Z');

  assert.equal(fragment.source_type, 'memory_fact');
  assert.equal(fragment.trusted, true);
  assert.equal(fragment.content, 'Prefer provider-based prompt context.');
  assert.equal(fragment.metadata.category, 'lesson');
  assert.equal(fragment.manifest.item_kind, 'lesson');
  assert.equal(fragment.manifest.item_id, 'm1');
});
