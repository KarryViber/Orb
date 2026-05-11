import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolEventState } from '../../src/worker/tool-event-state.js';

test('tool state records tool_use counts and last tool', () => {
  const state = createToolEventState();
  state.recordToolUse({ id: 'tool-1', name: 'Read', input: { file_path: 'a.js' } });
  const snapshot = state.snapshotForCcEvent();
  assert.equal(snapshot.totalToolCount, 1);
  assert.equal(snapshot.turnToolCount, 1);
  assert.equal(snapshot.lastTool, 'Read');
});

test('tool state moves pending tool to completed on result', () => {
  const state = createToolEventState();
  state.recordToolUse({ id: 'tool-1', name: 'Bash', input: { command: 'pwd' } });
  state.recordToolResult({ tool_use_id: 'tool-1', content: 'ok' });
  const snapshot = state.snapshotForCcEvent();
  assert.equal(snapshot.pendingTools.length, 0);
  assert.equal(snapshot.completedTools.length, 1);
});

test('tool state rebuilds TodoWrite snapshot', () => {
  const state = createToolEventState();
  state.recordToolUse({ name: 'TodoWrite', input: { todos: [{ content: 'ship', status: 'in_progress' }] } });
  assert.deepEqual(state.snapshotForCcEvent().todos, [{ content: 'ship', status: 'in_progress' }]);
});

test('tool state resetTurn preserves total count and clears per-turn buckets', () => {
  const state = createToolEventState();
  state.recordToolUse({ id: 'tool-1', name: 'Read', input: {} });
  state.resetTurn();
  const snapshot = state.snapshotForCcEvent();
  assert.equal(snapshot.totalToolCount, 1);
  assert.equal(snapshot.turnToolCount, 0);
  assert.equal(snapshot.pendingTools.length, 0);
});
