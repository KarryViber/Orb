import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSkillReviewTrigger } from '../src/skill-review-trigger.js';

test('skill trigger: repeated action', () => {
  const result = assessSkillReviewTrigger(['Read', 'Edit', 'Read', 'Edit']);
  assert.equal(result.should, true);
  assert.equal(result.pattern, 'repeated_action');
});

test('skill trigger: multi-step workflow', () => {
  const result = assessSkillReviewTrigger(['Read', 'Grep', 'Edit']);
  assert.equal(result.should, true);
  assert.equal(result.pattern, 'multi_step_workflow');
});

test('skill trigger: sustained tool combination', () => {
  const result = assessSkillReviewTrigger(['Read', 'Edit', 'Edit', 'Read']);
  assert.equal(result.should, true);
  assert.equal(result.pattern, 'tool_combination');
});

test('skill trigger: repair pattern', () => {
  const result = assessSkillReviewTrigger([{ name: 'Bash', input: { output: 'failed: ENOENT' } }, { name: 'Edit', input: { file_path: 'x' } }, { name: 'Bash', input: { command: 'npm test' } }]);
  assert.equal(result.should, true);
  assert.equal(result.pattern, 'repair_pattern');
});

test('skill trigger: explicit user request', () => {
  const result = assessSkillReviewTrigger(['Read', 'Edit', 'Bash'], { userText: '这个步骤记一下' });
  assert.equal(result.should, true);
  assert.equal(result.pattern, 'explicit_user');
});

test('skill trigger skip: one-off', () => {
  const result = assessSkillReviewTrigger(['Read', 'Edit']);
  assert.equal(result.should, false);
  assert.equal(result.pattern, 'one_off');
});

test('skill trigger skip: trivial read-only', () => {
  const result = assessSkillReviewTrigger(['Read', 'Read', 'Read']);
  assert.equal(result.should, false);
  assert.equal(result.pattern, 'trivial');
});

test('skill trigger skip: existing coverage', () => {
  const result = assessSkillReviewTrigger(['Read', 'Edit', 'Bash'], {
    userText: 'deploy migration rollback',
    existingSkillText: 'How to deploy a migration and handle rollback safely',
  });
  assert.equal(result.should, false);
  assert.equal(result.pattern, 'existing_skill');
});

test('skill trigger skip: context-specific paths', () => {
  const result = assessSkillReviewTrigger([
    { name: 'Read', input: { file_path: '/Users/karry/Orb/profiles/karry/workspace/work/project/a.md' } },
    { name: 'Edit', input: { file_path: '/Users/karry/Orb/profiles/karry/workspace/work/project/b.md' } },
    { name: 'Read', input: { file_path: '/Users/karry/Orb/profiles/karry/workspace/work/project/c.md' } },
  ]);
  assert.equal(result.should, false);
  assert.equal(result.pattern, 'context_specific');
});
