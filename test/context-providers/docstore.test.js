import test from 'node:test';
import assert from 'node:assert/strict';
import { docsToFragments } from '../../src/context-providers/docstore.js';

test('docstore provider maps docs to labeled fragments with doc manifest items', () => {
  const [fragment] = docsToFragments([{
    slug: 'orb',
    doc_type: 'spec',
    path: '/tmp/spec.md',
    title: 'Context Provider Spec',
    section: 'Design',
    snippet: 'Provider output must be labeled fragments.',
  }], '2026-05-01T00:00:00.000Z');

  assert.equal(fragment.source_type, 'doc_snippet');
  assert.equal(fragment.origin, 'orb#spec#/tmp/spec.md#Design');
  assert.equal(fragment.source_path, '/tmp/spec.md');
  assert.equal(fragment.metadata.slug, 'orb');
  assert.equal(fragment.manifest.item_kind, 'doc');
  assert.equal(fragment.manifest.item_id, 'orb#spec#/tmp/spec.md#Design');
});
