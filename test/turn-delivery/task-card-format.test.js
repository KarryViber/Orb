import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInterruptedPlanSnapshotText,
  buildPlanSnapshotRows,
  buildPlanSnapshotTitle,
  categorizeTool,
  planSnapshotLineForRow,
} from '../../src/turn-delivery/task-card-format.js';

test('buildPlanSnapshotRows returns empty rows for non-array input', () => {
  assert.deepEqual(buildPlanSnapshotRows(null), []);
});

test('buildPlanSnapshotRows formats a single todo with fallback title', () => {
  assert.deepEqual(buildPlanSnapshotRows([{ status: 'in_progress' }]), [{
    task_id: 'todowrite-todo-0',
    title: 'Todo 1',
    status: 'in_progress',
  }]);
});

test('buildPlanSnapshotRows maps multiple todo statuses', () => {
  assert.deepEqual(buildPlanSnapshotRows([
    { content: 'done', status: 'completed' },
    { content: 'waiting', status: 'pending' },
    { content: 'unknown', status: 'blocked' },
  ]), [
    { task_id: 'todowrite-todo-0', title: 'done', status: 'complete' },
    { task_id: 'todowrite-todo-1', title: 'waiting', status: 'pending' },
    { task_id: 'todowrite-todo-2', title: 'unknown', status: 'pending' },
  ]);
});

test('buildPlanSnapshotTitle handles empty, active, and complete plans', () => {
  assert.equal(buildPlanSnapshotTitle([]), '进度 0/0');
  assert.equal(buildPlanSnapshotTitle([
    { content: 'one', status: 'completed' },
    { content: 'two', status: 'in_progress' },
  ]), '进度 1/2｜two');
  assert.equal(buildPlanSnapshotTitle([{ content: 'one', status: 'completed' }]), '进度 1/1｜完成');
});

test('buildPlanSnapshotTitle truncates long active todo text', () => {
  const title = buildPlanSnapshotTitle([{ content: 'x'.repeat(80), status: 'in_progress' }]);
  assert.equal(title.slice('进度 0/1｜'.length).length, 40);
  assert.match(title, /\.\.\.$/);
});

test('categorizeTool maps probe, delegate, distill, and unknown boundary names', () => {
  assert.equal(categorizeTool('Bash'), 'Probe');
  assert.equal(categorizeTool('mcp__orb__tool'), 'Delegate');
  assert.equal(categorizeTool('summary'), 'Distill');
  assert.equal(categorizeTool('bash'), null);
  assert.equal(categorizeTool('WebSearchExtra'), null);
});

test('planSnapshotLineForRow renders status icons', () => {
  assert.equal(planSnapshotLineForRow({ title: 'A', status: 'complete' }), '✓ A');
  assert.equal(planSnapshotLineForRow({ title: 'B', status: 'in_progress' }), '🔵 B ← 中断点');
  assert.equal(planSnapshotLineForRow({ title: 'C', status: 'error' }), '✗ C');
  assert.equal(planSnapshotLineForRow({ title: 'D', status: 'pending' }), '○ D');
  assert.equal(planSnapshotLineForRow({ title: 'E' }), '○ E');
  assert.equal(planSnapshotLineForRow({ title: '', status: 'complete' }), '');
  assert.equal(planSnapshotLineForRow(null), '');
});

test('buildInterruptedPlanSnapshotText renders header + plan rows + footer', () => {
  const text = buildInterruptedPlanSnapshotText({
    attemptId: 'attempt-123',
    stopReason: 'worker_timeout',
    rows: [
      { title: 'step 1', status: 'complete' },
      { title: 'step 2', status: 'in_progress' },
      { title: 'step 3', status: 'pending' },
    ],
  });
  assert.match(text, /🛑 \*任务中断快照\* — turn attempt-123 · stopReason=worker_timeout/);
  assert.match(text, /✓ step 1/);
  assert.match(text, /🔵 step 2 ← 中断点/);
  assert.match(text, /○ step 3/);
  assert.match(text, /发「继续」让新 worker 从此处续做。/);
});

test('buildInterruptedPlanSnapshotText falls back when rows empty', () => {
  const text = buildInterruptedPlanSnapshotText({ attemptId: '', stopReason: '', rows: [] });
  assert.match(text, /stopReason=unknown/);
  assert.match(text, /○ 暂无 TodoWrite plan snapshot/);
});
