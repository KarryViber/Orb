import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeliveryChannel } from '../../src/turn-delivery/adapter-strategy.js';
import {
  ASSISTANT_TEXT_FINAL,
  ASSISTANT_TEXT_DELTA,
} from '../../src/turn-delivery/intents.js';

function makeIntent(type, meta = {}) {
  return { intent: type, meta };
}

test('ASSISTANT_TEXT_FINAL: already-streamed without receipt → silent', () => {
  const result = resolveDeliveryChannel({
    adapter: { capabilities: {} },
    intent: makeIntent(ASSISTANT_TEXT_FINAL),
    turnState: { streamId: null, assistantStreamTextLen: 10 },
  });
  assert.deepEqual(result, { channel: 'silent', reason: 'already-streamed' });
});

test('ASSISTANT_TEXT_FINAL: already-streamed with dailyNotesSummary → silent', () => {
  const result = resolveDeliveryChannel({
    adapter: { capabilities: {} },
    intent: makeIntent(ASSISTANT_TEXT_FINAL, { dailyNotesSummary: { count: 1 } }),
    turnState: { streamId: null, assistantStreamTextLen: 10 },
  });
  assert.deepEqual(result, { channel: 'silent', reason: 'already-streamed' });
});

test('ASSISTANT_TEXT_FINAL: already-streamed with gitDiffSummary.hasChanges → silent', () => {
  const result = resolveDeliveryChannel({
    adapter: { capabilities: {} },
    intent: makeIntent(ASSISTANT_TEXT_FINAL, { gitDiffSummary: { hasChanges: true } }),
    turnState: { streamId: null, assistantStreamTextLen: 10 },
  });
  assert.deepEqual(result, { channel: 'silent', reason: 'already-streamed' });
});

test('ASSISTANT_TEXT_FINAL: no stream text, no streamId → postMessage', () => {
  const result = resolveDeliveryChannel({
    adapter: { capabilities: {} },
    intent: makeIntent(ASSISTANT_TEXT_FINAL),
    turnState: { streamId: null, assistantStreamTextLen: 0 },
  });
  assert.deepEqual(result, { channel: 'postMessage', reason: 'assistant-text-no-stream' });
});

test('ASSISTANT_TEXT_DELTA: no stream → silent', () => {
  const result = resolveDeliveryChannel({
    adapter: { capabilities: {} },
    intent: makeIntent(ASSISTANT_TEXT_DELTA),
    turnState: { streamId: null },
  });
  assert.deepEqual(result, { channel: 'silent', reason: 'delta-without-stream' });
});
