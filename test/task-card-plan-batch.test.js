import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanSnapshotRows,
  buildPlanSnapshotTitle,
} from '../src/adapters/slack-format.js';
import {
  shouldEmitTaskCardForTool,
} from '../src/worker.js';

test('buildPlanSnapshotRows batches TodoWrite todos into ordered plan rows', () => {
  const rows = buildPlanSnapshotRows([
    { content: '第一步', status: 'in_progress' },
    { content: '第二步', status: 'completed' },
    { content: '第三步', status: 'pending' },
  ]);

  assert.deepEqual(rows, [
    { task_id: 'todowrite-todo-0', title: '第一步', status: 'in_progress' },
    { task_id: 'todowrite-todo-1', title: '第二步', status: 'complete' },
    { task_id: 'todowrite-todo-2', title: '第三步', status: 'pending' },
  ]);
});

test('buildPlanSnapshotTitle omits active suffix when all todos are pending', () => {
  assert.equal(buildPlanSnapshotTitle([
    { content: '第一步', status: 'pending' },
    { content: '第二步', status: 'pending' },
    { content: '第三步', status: 'pending' },
  ]), '进度 0/3');
});

test('buildPlanSnapshotTitle includes active step and truncates it to 40 chars', () => {
  assert.equal(buildPlanSnapshotTitle([
    { content: '第一步', status: 'completed' },
    { content: 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMN', status: 'in_progress' },
    { content: '第三步', status: 'pending' },
  ]), '进度 1/3｜abcdefghijklmnopqrstuvwxyz1234567890A...');
});

test('buildPlanSnapshotTitle marks all-complete plans as finished', () => {
  assert.equal(buildPlanSnapshotTitle([
    { content: '第一步', status: 'completed' },
    { content: '第二步', status: 'completed' },
  ]), '进度 2/2｜完成');
});

test('shouldEmitTaskCardForTool includes narrative + routine tools on the task-card path', () => {
  assert.equal(shouldEmitTaskCardForTool('Bash', { command: 'ls' }, 'toolu_1'), true);
  assert.equal(shouldEmitTaskCardForTool('WebSearch', { query: 'orb' }, 'toolu_2'), true);
  assert.equal(shouldEmitTaskCardForTool('Task', { description: 'delegate' }, 'toolu_3'), true);
  assert.equal(shouldEmitTaskCardForTool('Skill', { skill_name: 'openai-docs' }, 'toolu_4'), true);
  assert.equal(shouldEmitTaskCardForTool('TodoWrite', {
    todos: [{ content: '第一步', status: 'in_progress' }],
  }), true);
  assert.equal(shouldEmitTaskCardForTool('UnknownTool', {}, 'toolu_5'), false);
});
