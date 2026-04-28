import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnCompleteDeliveryText, subtractDeliveredText } from '../src/scheduler.js';

test('resolveTurnCompleteDeliveryText returns text minus segments', () => {
  const deliveryText = resolveTurnCompleteDeliveryText({
    text: '先说 A。\n\n然后 B 和 C。',
    segments: ['先说 A。'],
  });

  assert.equal(deliveryText, '\n\n然后 B 和 C。');
});

test('resolveTurnCompleteDeliveryText keeps pure text turns unchanged', () => {
  const deliveryText = resolveTurnCompleteDeliveryText({
    text: '完整最终答复',
    segments: [],
  });

  assert.equal(deliveryText, '完整最终答复');
});

test('resolveTurnCompleteDeliveryText skips fully covered segment text', () => {
  assert.equal(resolveTurnCompleteDeliveryText({
    text: '完整最终答复',
    segments: ['完整最终答复'],
  }), '');
});

test('subtractDeliveredText returns empty when streamed chunks already cover the whole final text', () => {
  const remaining = subtractDeliveredText('先说 A。', ['先说 A。']);

  assert.equal(remaining, '');
});

test('subtractDeliveredText treats ordered streamed chunks separated by whitespace as delivered', () => {
  const remaining = subtractDeliveredText(
    '等一下--我先验证再动手。\n\n不需要动了。事实链对不上，停手。',
    ['等一下--我先验证再动手。', '不需要动了。事实链对不上，停手。'],
  );

  assert.equal(remaining, '');
});

test('subtractDeliveredText keeps non-streamed text between ordered chunks', () => {
  const remaining = subtractDeliveredText(
    '第一段\n\n新增结论\n\n第二段',
    ['第一段', '第二段'],
  );

  assert.equal(remaining, '\n\n新增结论\n\n');
});
