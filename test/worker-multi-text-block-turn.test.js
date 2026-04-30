import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnCompleteText } from '../src/worker-turn-text.js';

function createTurnTextHarness() {
  let turnBuffer = [];
  let lastEmittedText = '';
  let blocksSinceLastEmit = 0;
  const emitted = [];

  function handleStreamMsg(msg) {
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          turnBuffer.push(block.text);
          blocksSinceLastEmit++;
        }
      }
    }

    if (msg.type === 'result') {
      const resolved = resolveTurnCompleteText({
        turnBuffer,
        msgResult: msg.result,
        lastEmittedText,
        blocksSinceLastEmit,
      });
      if (resolved.shouldEmit) {
        emitted.push(resolved.text);
        lastEmittedText = resolved.text;
        blocksSinceLastEmit = 0;
      }
      turnBuffer = [];
    }
  }

  return { emitted, handleStreamMsg };
}

test('multi text-block turn emits full buffer once and suppresses repeated result tail', () => {
  const harness = createTurnTextHarness();
  const stream = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } },
    { type: 'result', result: 'B', stop_reason: 'end_turn' },
    { type: 'result', result: 'B', stop_reason: 'end_turn' },
  ];

  for (const msg of stream) harness.handleStreamMsg(msg);

  assert.deepEqual(harness.emitted, ['A\nB']);
});
