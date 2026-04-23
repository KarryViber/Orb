import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskCardChunksFromState,
  ensureTaskCardStreamStarted,
  makeTaskCardState,
  replaceTaskCardSnapshotRows,
  shouldIncludeTaskCardPlanUpdate,
} from '../src/scheduler.js';
import {
  buildPlanSnapshotRows,
  buildPlanSnapshotTitle,
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

test('buildTaskCardChunksFromState prepends plan_update for plan snapshots', () => {
  const state = makeTaskCardState({ enabled: true });
  state.displayMode = 'plan';
  state.planTitle = '进度';
  state.taskCards = replaceTaskCardSnapshotRows([
    { task_id: 'todowrite-todo-0', title: '第一步', status: 'in_progress' },
    { task_id: 'todowrite-todo-1', title: '第二步', status: 'pending' },
  ]);

  const chunks = buildTaskCardChunksFromState(state);

  assert.deepEqual(chunks, [
    { type: 'plan_update', title: '进度' },
    { type: 'task_update', id: 'todowrite-todo-0', title: '第一步', status: 'in_progress' },
    { type: 'task_update', id: 'todowrite-todo-1', title: '第二步', status: 'pending' },
  ]);
});

test('shouldIncludeTaskCardPlanUpdate only flips true when the plan title changes', () => {
  const state = makeTaskCardState({ enabled: true });
  state.displayMode = 'plan';
  state.planTitle = '进度 1/3｜执行核心流程';

  assert.equal(shouldIncludeTaskCardPlanUpdate(state), true);

  state.lastSentPlanTitle = '进度 1/3｜执行核心流程';
  assert.equal(shouldIncludeTaskCardPlanUpdate(state), false);

  state.planTitle = '进度 2/3｜执行核心流程';
  assert.equal(shouldIncludeTaskCardPlanUpdate(state), true);
});

test('ensureTaskCardStreamStarted gates concurrent startStream calls', async () => {
  const state = makeTaskCardState({ enabled: true });
  state.chunkType = 'task';
  state.displayMode = 'plan';
  state.planTitle = '进度';
  state.taskCards = replaceTaskCardSnapshotRows([
    { task_id: 'todowrite-todo-0', title: '第一步', status: 'in_progress' },
  ]);

  let startCalls = 0;
  let keepaliveCalls = 0;
  let failureCalls = 0;
  let disabledCalls = 0;

  const adapter = {
    startStream: async (_channel, _threadTs, options) => {
      startCalls += 1;
      assert.equal(options.task_display_mode, 'plan');
      assert.deepEqual(options.initial_chunks, [
        { type: 'plan_update', title: '进度' },
        { type: 'task_update', id: 'todowrite-todo-0', title: '第一步', status: 'in_progress' },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { stream_id: 'stream-1', ts: '123.456' };
    },
  };

  const startA = ensureTaskCardStreamStarted({
    taskCardState: state,
    hasTaskCardThread: () => true,
    disableTaskCardStreaming: () => { disabledCalls += 1; },
    adapter,
    channel: 'C123',
    effectiveThreadTs: '111.222',
    teamId: 'T123',
    buildTaskCardChunks: () => buildTaskCardChunksFromState(state),
    armKeepalive: () => { keepaliveCalls += 1; },
    failTaskCardStream: async () => { failureCalls += 1; },
  });
  const startB = ensureTaskCardStreamStarted({
    taskCardState: state,
    hasTaskCardThread: () => true,
    disableTaskCardStreaming: () => { disabledCalls += 1; },
    adapter,
    channel: 'C123',
    effectiveThreadTs: '111.222',
    teamId: 'T123',
    buildTaskCardChunks: () => buildTaskCardChunksFromState(state),
    armKeepalive: () => { keepaliveCalls += 1; },
    failTaskCardStream: async () => { failureCalls += 1; },
  });

  const [resultA, resultB] = await Promise.all([startA, startB]);

  assert.equal(resultA, true);
  assert.equal(resultB, true);
  assert.equal(startCalls, 1);
  assert.equal(keepaliveCalls, 1);
  assert.equal(failureCalls, 0);
  assert.equal(disabledCalls, 0);
  assert.equal(state.streamId, 'stream-1');
  assert.equal(state.streamTs, '123.456');
  assert.equal(state.startStreamPromise, null);
});

test('shouldEmitTaskCardForTool only keeps narrative tools on the task-card path', () => {
  assert.equal(shouldEmitTaskCardForTool('Bash', { command: 'ls' }, 'toolu_1'), false);
  assert.equal(shouldEmitTaskCardForTool('WebSearch', { query: 'orb' }, 'toolu_2'), false);
  assert.equal(shouldEmitTaskCardForTool('Task', { description: 'delegate' }, 'toolu_3'), true);
  assert.equal(shouldEmitTaskCardForTool('Skill', { skill_name: 'openai-docs' }, 'toolu_4'), true);
  assert.equal(shouldEmitTaskCardForTool('TodoWrite', {
    todos: [{ content: '第一步', status: 'in_progress' }],
  }), true);
});
