import test from 'node:test';
import assert from 'node:assert/strict';
import { createCcStreamParseState, parseStreamLine } from '../../src/worker/cc-stream-parser.js';

test('parseStreamLine ignores empty lines', () => {
  const state = createCcStreamParseState();
  const result = parseStreamLine('   ', state);
  assert.deepEqual(result.events, []);
  assert.equal(result.newState, state);
});

test('parseStreamLine reports damaged JSON without mutating state', () => {
  const state = createCcStreamParseState();
  const result = parseStreamLine('{bad', state);
  assert.equal(result.events[0].type, 'parse_error');
  assert.equal(result.newState, state);
});

test('parseStreamLine emits text cc_event and buffers text', () => {
  const state = createCcStreamParseState();
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } });
  const result = parseStreamLine(line, state);
  assert.equal(result.events.some((event) => event.eventType === 'text'), true);
  assert.deepEqual(result.newState.turnBuffer, ['A']);
});

test('parseStreamLine emits tool_use and tool_result events in sequence', () => {
  let state = createCcStreamParseState();
  state = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }), state).newState;
  const result = parseStreamLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }), state);
  assert.deepEqual(result.events.filter((event) => event.type === 'cc_event').map((event) => event.eventType), ['tool_result']);
});

test('parseStreamLine resolves multi-block turn text and dedups repeated result tail', () => {
  let state = createCcStreamParseState();
  state = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }), state).newState;
  state = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }), state).newState;
  let result = parseStreamLine(JSON.stringify({ type: 'result', result: 'B', stop_reason: 'end_turn' }), state);
  assert.equal(result.events.find((event) => event.type === 'turn_result').resolvedTurn.text, 'A\nB');
  state = result.newState;
  result = parseStreamLine(JSON.stringify({ type: 'result', result: 'B', stop_reason: 'end_turn' }), state);
  assert.equal(result.events.find((event) => event.type === 'turn_result').resolvedTurn.shouldEmit, false);
});

test('parseStreamLine classifies max_turns_reached attachment as stop override', () => {
  let state = createCcStreamParseState();
  state = parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }, { type: 'max_turns_reached' }] } }), state).newState;
  const result = parseStreamLine(JSON.stringify({ type: 'result', result: 'A', stop_reason: 'end_turn' }), state);
  assert.equal(result.events.find((event) => event.type === 'turn_result').stopReason, 'max_turns_reached');
});
