import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnCompleteDeliveryText, subtractDeliveredText } from '../src/scheduler.js';
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

test('resolveTurnCompleteDeliveryText falls back to text minus deliveredTexts when worker omits undeliveredText', () => {
  const deliveryText = resolveTurnCompleteDeliveryText({
    text: '先说 A。\n\n然后 B 和 C。',
    deliveredTexts: ['先说 A。'],
  });

  assert.equal(deliveryText, '\n\n然后 B 和 C。');
});

test('resolveTurnCompleteDeliveryText keeps pure text turns unchanged', () => {
  const deliveryText = resolveTurnCompleteDeliveryText({
    text: '完整最终答复',
    deliveredTexts: [],
  });

  assert.equal(deliveryText, '完整最终答复');
});

test('resolveTurnCompleteDeliveryText prefers explicit undeliveredText and skips whitespace-only diffs', () => {
  assert.equal(resolveTurnCompleteDeliveryText({
    text: '完整最终答复',
    undeliveredText: '\n\n补充结论',
    deliveredTexts: ['完整最终答复'],
  }), '\n\n补充结论');

  assert.equal(resolveTurnCompleteDeliveryText({
    text: '完整最终答复',
    undeliveredText: '   \n',
    deliveredTexts: [],
  }), '');
});

test('subtractDeliveredText returns empty when streamed chunks already cover the whole final text', () => {
  const remaining = subtractDeliveredText('先说 A。', ['先说 A。']);

  assert.equal(remaining, '');
});
