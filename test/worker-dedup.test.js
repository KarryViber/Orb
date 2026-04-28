import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const removedTurnTextMarker = ['_last', 'Emitted', 'TurnText'].join('');
const removedDiffHelper = ['compute', 'Undelivered', 'TurnText'].join('');

test('worker result IPC never carries final text', () => {
  const source = readFileSync(join(root, 'src', 'worker.js'), 'utf8');

  assert.equal(source.includes(removedDiffHelper), false);
  assert.equal(source.includes(removedTurnTextMarker), false);
  assert.match(source, /type:\s*'result',\s*\n\s*text:\s*''/);
});
