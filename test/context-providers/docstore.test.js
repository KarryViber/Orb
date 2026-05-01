import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('inferSlugFromThread reuses registry parse while mtime is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-docstore-registry-'));
  const registryPath = join(dir, 'registry.md');
  writeFileSync(registryPath, [
    '## Internal',
    '| slug | name | kind | aliases |',
    '| --- | --- | --- | --- |',
    '| orb | Orb | app | Orb/小球 |',
    '',
  ].join('\n'));

  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    let reads = 0;
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(path, ...args) {
      if (path === process.env.DOC_REGISTRY_PATH) reads += 1;
      return originalReadFileSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const { inferSlugFromThread } = await import('./src/context-providers/docstore.js');
    for (let i = 0; i < 10; i += 1) {
      const slug = inferSlugFromThread('user: Orb registry cache test');
      if (slug !== 'orb') throw new Error('unexpected slug: ' + slug);
    }
    console.log(String(reads));
  `;

  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, DOC_REGISTRY_PATH: registryPath },
    encoding: 'utf8',
  }).trim();

  assert.equal(output, '1');
});
