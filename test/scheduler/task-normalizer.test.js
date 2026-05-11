import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeTaskForSpawn, InvalidTaskError } from '../../src/scheduler/task-normalizer.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'orb-task-normalizer-test-'));
const profile = {
  name: 'test-profile',
  workspaceDir: join(TEST_ROOT, 'workspace'),
  dataDir: join(TEST_ROOT, 'data'),
};
const defaults = { model: 'sonnet', effort: 'medium' };

test('normalizeTaskForSpawn applies defaults and attempt origin fields', () => {
  const task = { userText: 'hello', threadTs: 't1', userId: 'u1', platform: 'slack' };
  const result = normalizeTaskForSpawn(task, { getProfile: () => profile, defaults });

  assert.equal(result.profile, profile);
  assert.equal(result.modelEffort.model, 'sonnet');
  assert.equal(result.modelEffort.effort, 'medium');
  assert.equal(result.modelEffort.text, 'hello');
  assert.equal(task.channelSemantics, 'reply');
  assert.equal(task.origin.kind, 'user');
  assert.match(task.attemptId, /^attempt-/);
});

test('normalizeTaskForSpawn parses model and effort prefixes', () => {
  const task = { userText: '[opus] [effort:high] do it', userId: 'u1' };
  const result = normalizeTaskForSpawn(task, { getProfile: () => profile, defaults });

  assert.equal(result.modelEffort.model, 'opus');
  assert.equal(result.modelEffort.effort, 'high');
  assert.equal(result.modelEffort.text, 'do it');
});

test('normalizeTaskForSpawn preserves explicit task model and effort', () => {
  const task = { userText: '[haiku] ignored', model: 'sonnet', effort: 'low', userId: 'u1' };
  const result = normalizeTaskForSpawn(task, { getProfile: () => profile, defaults });

  assert.equal(result.modelEffort.model, 'sonnet');
  assert.equal(result.modelEffort.effort, 'low');
  assert.equal(result.modelEffort.text, '[haiku] ignored');
});

test('normalizeTaskForSpawn preserves launcher_result origin', () => {
  const task = {
    userText: 'launcher done',
    userId: 'u1',
    origin: { kind: 'launcher_result', name: 'spec-smoke', parentAttemptId: 'attempt-parent' },
  };
  normalizeTaskForSpawn(task, { getProfile: () => profile, defaults });

  assert.deepEqual(task.origin, {
    kind: 'launcher_result',
    name: 'spec-smoke',
    parentAttemptId: 'attempt-parent',
  });
});

test('normalizeTaskForSpawn escalates review-like prompts when effort is absent', () => {
  const task = { userText: '请帮我做一次深入分析这个架构设计和边界条件', userId: 'u1' };
  const result = normalizeTaskForSpawn(task, { getProfile: () => profile, defaults });

  assert.equal(result.modelEffort.effort, 'xhigh');
});

test('normalizeTaskForSpawn wraps profile lookup failures', () => {
  assert.throws(
    () => normalizeTaskForSpawn({ userId: 'missing' }, {
      getProfile: () => { throw new Error('no profile'); },
      defaults,
    }),
    InvalidTaskError,
  );
});
