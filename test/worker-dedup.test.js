import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUndeliveredTurnText } from '../src/worker.js';

test('computeUndeliveredTurnText only returns the remaining suffix after streamed chunks', () => {
  const chunkA = '先说 A。';
  const finalText = '先说 A。\n\n然后 B 和 C。';

  const undelivered = computeUndeliveredTurnText(finalText, chunkA, [chunkA]);

  assert.equal(undelivered, '\n\n然后 B 和 C。');
});

test('computeUndeliveredTurnText skips fully delivered finals', () => {
  const finalText = '已经完整发过了';

  const undelivered = computeUndeliveredTurnText(finalText, finalText, [finalText]);

  assert.equal(undelivered, '');
});
