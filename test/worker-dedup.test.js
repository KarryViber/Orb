import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUndeliveredTurnText } from '../src/worker.js';

test('computeUndeliveredTurnText only returns the remaining suffix after streamed chunks', () => {
  const chunkA = '第一段';
  const chunkB = '第二段';
  const finalText = '第一段第二段第三段';

  const undelivered = computeUndeliveredTurnText(finalText, `${chunkA}${chunkB}`, [chunkA, chunkB]);

  assert.equal(undelivered, '第三段');
});

test('computeUndeliveredTurnText skips fully delivered finals', () => {
  const finalText = '已经完整发过了';

  const undelivered = computeUndeliveredTurnText(finalText, finalText, [finalText]);

  assert.equal(undelivered, '');
});
